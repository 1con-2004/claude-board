#!/usr/bin/env node
/**
 * Session Monitor — 多终端 Claude Code 会话状态监控服务
 *
 * 监听 ~/.claude/projects/ 下的 session JSONL 文件变化 + 可选 hook 心跳，
 * 推断每个终端的实时状态 (working / interrupt / idle / done)，
 * 按项目分组，通过 SSE 推送到大屏看板。
 *
 * 端口: 3211
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// ─── 配置 ───
const PORT = Number(process.env.SESSION_PORT || 3211);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const POLL_MS = 2000;
const HOOK_PING_GRACE_MS = 15000;
const IDLE_THRESHOLD_MS = 45000;
const DONE_THRESHOLD_MS = 300000;
const SESSION_CLEANUP_IDLE_MS = 2 * 60 * 60 * 1000;    // idle > 2h 删除
const SESSION_CLEANUP_DONE_MS = 30 * 60 * 1000;         // done > 30min 删除
const SNAPSHOT_ACTIVE_WINDOW_MS = 4 * 60 * 60 * 1000;   // 快照仅返回 4h 内活跃的
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

// ─── 状态存储 ───
const sessions = new Map();   // sessionId -> SessionState
const sseClients = new Set(); // res 对象
const filePositions = new Map(); // filePath -> byte offset
const projectNameCache = new Map(); // hash -> { projectName, projectPath }

let serverStartedAt = new Date().toISOString();

// ─── Session 状态类型 ───
/**
 * @typedef {Object} SessionState
 * @property {string} id
 * @property {string} project - 项目目录名 (e.g. "AI旅拍")
 * @property {string} projectPath - 项目完整路径
 * @property {string} cwd - 工作目录
 * @property {"working"|"interrupt"|"idle"|"done"} status
 * @property {string} lastActivityAt - ISO timestamp
 * @property {string} startedAt - ISO timestamp
 * @property {number} lastEventIndex
 * @property {Object} [hookPing] - 最近一次 hook 心跳
 * @property {string} [summary] - 最近执行摘要
 */

// ─── MIME ───
function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  return map[ext] || "application/octet-stream";
}

// ─── 工具函数 ───
function isProcessAlive(pid) {
  try { return process.kill(pid, 0); }
  catch { return false; }
}

function formatDuration(ms) {
  if (ms < 1000) return "刚刚";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s 前`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s 前`;
}

// ─── 项目目录扫描 ───
async function getProjectDirs() {
  try {
    const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => ({ hash: e.name, dir: path.join(PROJECTS_DIR, e.name) }));
  } catch { return []; }
}

function getJsonlFiles(projectDir) {
  try {
    return fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl")).map(f => path.join(projectDir, f));
  } catch { return []; }
}

async function scanAllJsonlFiles() {
  const dirs = await getProjectDirs();
  const files = [];
  for (const d of dirs) { files.push(...getJsonlFiles(d.dir).map(f => ({ filePath: f, hash: d.hash }))); }
  return files;
}

// ─── 项目名解析 ───
async function resolveProjectName(hash) {
  if (projectNameCache.has(hash)) return projectNameCache.get(hash);
  const dir = path.join(PROJECTS_DIR, hash);
  const files = getJsonlFiles(dir);

  // 读取 session 文件的初始 cwd，用于推断项目根路径
  let cwd = null;
  for (const f of files.sort().reverse()) {
    try {
      const content = await fsp.readFile(f, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.cwd) { cwd = d.cwd; break; }
        } catch { continue; }
      }
      if (cwd) break;
    } catch { continue; }
  }

  if (cwd) {
    // 从 cwd 向上查找真正的项目根路径（有 .git 的目录）
    let projectPath = cwd;
    let prev = "";
    let steps = 0;
    const MAX_WALK = 8;

    while (projectPath !== prev && steps < MAX_WALK) {
      prev = projectPath;
      const parent = path.dirname(projectPath);
      if (parent === projectPath) break;

      // 有 .git → 这就是项目根
      const hasGit = await fsp.access(path.join(projectPath, ".git")).then(() => true).catch(() => false);
      if (hasGit) break;

      // 走到用户 home 或系统根 → 停止
      if (parent === os.homedir() || parent === "/") break;

      projectPath = parent;
      steps++;
    }

    const projectName = path.basename(projectPath);
    const info = { projectName, projectPath };
    projectNameCache.set(hash, info);
    return info;
  }

  // 没有 cwd → 用 hash 目录作为项目路径，取最后一段有意义的名字
  const fallback = { projectName: path.basename(dir), projectPath: dir };
  projectNameCache.set(hash, fallback);
  return fallback;
}

// ─── 从 JSONL 读取新行 ───
async function readNewLines(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    const prevPos = filePositions.get(filePath) || 0;
    if (stat.size <= prevPos) {
      if (stat.size < prevPos) filePositions.set(filePath, 0);
      return [];
    }
    const fd = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(stat.size - prevPos);
    await fd.read(buf, 0, buf.length, prevPos);
    await fd.close();
    filePositions.set(filePath, stat.size);
    return buf.toString("utf-8").split("\n").filter(l => l.trim());
  } catch { return []; }
}

// ─── 推断会话状态 ───
function inferStatus(lastEvents, now, hookPing) {
  if (!lastEvents || lastEvents.length === 0) return "idle";

  const latest = lastEvents[0];
  const elapsed = now - new Date(latest.timestamp).getTime();

  // 过期判定
  if (elapsed > DONE_THRESHOLD_MS) return "done";
  if (elapsed > IDLE_THRESHOLD_MS) return "idle";

  // Hook 心跳
  if (hookPing && (now - new Date(hookPing.receivedAt).getTime()) < HOOK_PING_GRACE_MS) {
    return hookPing.status === "working" ? "working" : "interrupt";
  }

  // 最近 15s 内有 tool_use 活动 → 保持 working（防思考中误判）
  const TOOL_COOLDOWN_MS = 15000;
  const recentTool = lastEvents.some(e => {
    if (!e.timestamp) return false;
    return (now - new Date(e.timestamp).getTime()) < TOOL_COOLDOWN_MS && e.hasToolUse;
  });
  if (recentTool) return "working";

  // 当前事件有 tool_use → working
  if (latest.type === "assistant" && latest.hasToolUse) return "working";

  // user 消息 → working
  if (latest.type === "user") return "working";

  // assistant 纯文本 + 超过 10s 无活动 → interrupt
  if (latest.type === "assistant" && !latest.hasToolUse) {
    return elapsed < 10000 ? "working" : "interrupt";
  }

  return "idle";
}

// ─── 解析事件 ───
function parseEvent(d) {
  const ev = { timestamp: d.timestamp || new Date().toISOString(), type: d.type || "unknown", hasToolUse: false };
  if (d.type === "assistant" && d.message && Array.isArray(d.message.content)) {
    ev.hasToolUse = d.message.content.some(c =>
      c && typeof c === "object" && (c.name === "Skill" || c.type === "tool_use")
    );
  }
  return ev;
}

// ─── 处理单行日志 ───
async function processLine(line, hash) {
  try {
    const d = JSON.parse(line);
    const sessionId = d.sessionId;
    if (!sessionId) return;

    if (!sessions.has(sessionId)) {
      // 新会话 — 项目信息从此固定，不再随 cd 变化
      const proj = await resolveProjectName(hash);
      sessions.set(sessionId, {
        id: sessionId,
        title: "",         // 从 /rename 命令提取
        project: proj.projectName,
        projectPath: proj.projectPath,
        cwd: d.cwd || proj.projectPath,  // 初始 cwd
        currentDir: d.cwd || proj.projectPath, // 当前目录（可能变化）
        status: "working",
        lastActivityAt: d.timestamp || new Date().toISOString(),
        startedAt: d.timestamp || new Date().toISOString(),
        lastEvents: [],
        summary: "",
        hookPing: null,
      });
    }

    const session = sessions.get(sessionId);
    const ev = parseEvent(d);
    session.lastActivityAt = ev.timestamp;

    // 更新当前目录（不影响 project）
    if (d.cwd) {
      // 只保留相对项目根的部分作为 currentDir
      const rel = path.relative(session.projectPath, d.cwd);
      session.currentDir = rel || ".";  // 相对路径，根目录显示为 "."
      session.cwd = d.cwd;
    }

    // 检测 /rename 命令 → 提取自定义会话名
    if (d.type === "system" && d.subtype === "local_command" && typeof d.content === "string") {
      const renameMatch = d.content.match(/<command-name>\/rename<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (renameMatch) {
        session.title = renameMatch[1].trim();
      }
    }

    // 只保留最近 5 条
    session.lastEvents.unshift(ev);
    if (session.lastEvents.length > 5) session.lastEvents.pop();

    // 生成摘要
    if (d.type === "assistant" && d.message && Array.isArray(d.message.content)) {
      const texts = d.message.content.filter(c => typeof c === "object" && c.type === "text").map(c => c.text).join(" ").slice(0, 80);
      if (texts) session.summary = texts;
    }

  } catch { /* JSON parse error — skip */ }
}

// ─── 更新所有会话状态 ───
async function updateAllSessions() {
  const now = Date.now();

  for (const [id, session] of sessions) {
    const elapsed = now - new Date(session.lastActivityAt).getTime();

    // 状态推断
    session.status = inferStatus(session.lastEvents, now, session.hookPing);

    // 清理：done 超过 30min / idle 超过 2h → 删除
    if (session.status === "done" && elapsed > SESSION_CLEANUP_DONE_MS) {
      sessions.delete(id);
      continue;
    }
    if (session.status === "idle" && elapsed > SESSION_CLEANUP_IDLE_MS) {
      sessions.delete(id);
      continue;
    }
  }
}

// ─── 扫描循环 ───
async function scanRound() {
  const files = await scanAllJsonlFiles();

  for (const { filePath, hash } of files) {
    if (!filePositions.has(filePath)) {
      try {
        const stat = await fsp.stat(filePath);
        filePositions.set(filePath, stat.size);
        // 新文件 → 扫描前几行获取基本信息
        const content = await fsp.readFile(filePath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean).slice(0, 5);
        for (const line of lines) {
          await processLine(line, hash);
        }
      } catch { continue; }
      continue;
    }
    const lines = await readNewLines(filePath);
    for (const line of lines) {
      await processLine(line, hash);
    }
  }

  await updateAllSessions();
}

// ─── SSE ───
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); }
    catch { sseClients.delete(client); }
  }
}

function getSnapshot() {
  const projectsMap = new Map();
  const activeSessions = [];
  const now = Date.now();
  let archivedCount = 0;

  for (const [id, s] of sessions) {
    const elapsed = now - new Date(s.lastActivityAt).getTime();

    // 跳过超出活跃窗口的旧会话，统计归档数
    if (elapsed > SNAPSHOT_ACTIVE_WINDOW_MS) {
      archivedCount++;
      continue;
    }

    const entry = {
      id: id.slice(0, 8),
      title: s.title || "",
      project: s.project,
      projectPath: s.projectPath,
      cwd: s.cwd,
      currentDir: s.currentDir || ".",
      status: s.status,
      lastActivityAt: s.lastActivityAt,
      startedAt: s.startedAt,
      summary: s.summary || "",
      lastAgo: formatDuration(Date.now() - new Date(s.lastActivityAt).getTime()),
    };
    activeSessions.push(entry);

    if (!projectsMap.has(s.project)) {
      projectsMap.set(s.project, { name: s.project, path: s.projectPath, sessions: [] });
    }
    projectsMap.get(s.project).sessions.push(entry);
  }

  // 项目按名称字母排序（稳定不乱跳）
  const projects = [...projectsMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // 每个项目内的 session 按开始时间倒序（最新的在前）
  for (const p of projects) {
    p.sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  // 扁平列表也按项目+开始时间排序
  activeSessions.sort((a, b) => {
    const cmp = a.project.localeCompare(b.project);
    return cmp !== 0 ? cmp : new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });

  const counts = { working: 0, interrupt: 0, idle: 0, done: 0 };
  for (const s of activeSessions) { counts[s.status]++; }

  return {
    serverStartedAt,
    generatedAt: new Date().toISOString(),
    total: activeSessions.length,
    archived: archivedCount,
    counts,
    projects,
    sessions: activeSessions,
  };
}

// ─── 渲染看板 HTML ───
function renderDashboard() {
  return fsp.readFile(path.join(PUBLIC_DIR, "session-dashboard.html"), "utf8");
}

// ─── HTTP 路由 ───
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  // SSE
  if (pathname === "/api/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // API: 快照
  if (pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getSnapshot()));
    return;
  }

  // API: Hook 心跳
  if (pathname === "/api/ping" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        // 通过 PID 或 sessionId 关联已有会话
        // 如果提供 cwd，为该目录下的 session 注入心跳
        const now = new Date().toISOString();
        const pingInfo = { status: data.status || "working", cwd: data.cwd, pid: data.pid, receivedAt: now };

        // 尝试匹配存在的 session
        let matched = false;
        for (const [id, session] of sessions) {
          if (data.sessionId && session.id === data.sessionId) {
            session.hookPing = pingInfo;
            session.status = data.status || "working";
            session.lastActivityAt = now;
            matched = true;
            break;
          }
          if (data.cwd && session.cwd && session.cwd.startsWith(data.cwd)) {
            session.hookPing = pingInfo;
            session.status = data.status || "working";
            session.lastActivityAt = now;
            matched = true; // 匹配第一个
            break;
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, matched }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 看板页面
  if (pathname === "/" || pathname === "/session-dashboard.html") {
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, "session-dashboard.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
    return;
  }

  // 静态文件
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mimeType(filePath) });
    res.end(content);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

// ─── 启动 ───
async function main() {
  // 初始扫描 — 先设位置到尾端
  const initialFiles = await scanAllJsonlFiles();
  for (const { filePath } of initialFiles) {
    try {
      const stat = await fsp.stat(filePath);
      filePositions.set(filePath, stat.size);
    } catch { /* skip */ }
  }
  console.log(`扫描到 ${initialFiles.length} 个 session 文件`);

  // 回填：读取每个 session 文件末尾 30 行重建状态
  console.log("回填历史会话...");
  let backfilled = 0;
  for (const { filePath, hash } of initialFiles) {
    try {
      const stat = await fsp.stat(filePath);
      // 跳过超过活跃窗口的文件（未修改过说明早已结束）
      if (Date.now() - stat.mtimeMs > SNAPSHOT_ACTIVE_WINDOW_MS) continue;

      const content = await fsp.readFile(filePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const tail = lines.slice(-30);
      for (const line of tail) {
        await processLine(line, hash);
      }
      // 处理 /rename 命令可能存在于更早的行
      for (const line of lines) {
        if (line.includes("/rename")) {
          await processLine(line, hash);
        }
      }
      backfilled++;
    } catch { /* skip */ }
  }
  console.log(`回填 ${backfilled} 个文件, ${sessions.size} 个会话`);

  // 启动轮询
  setInterval(async () => {
    await scanRound();
    broadcast(getSnapshot());
  }, POLL_MS);

  // HTTP 服务
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`Session Monitor running at http://${HOST}:${PORT}`);
    console.log(`Poll interval: ${POLL_MS}ms`);
  });
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
