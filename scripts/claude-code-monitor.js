#!/usr/bin/env node
/**
 * Claude Code 会话日志监听器
 *
 * 监听 ~/.claude/projects/<project>/*.jsonl 文件变化，
 * 检测 Skill 调用事件并自动上报到 ClaudeBoard 看板。
 *
 * 检测逻辑：
 *   1. START — assistant 调用 Skill 工具 (type:assistant + name:Skill + input.skill)
 *   2. END   — user 返回 toolUseResult (type:user + toolUseResult.commandName)
 *   3. 匹配 tool_use_id 关联 start/end，计算耗时，POST 到 /api/events
 */

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:3210";
const POLL_MS = Number(process.env.CLAUDE_MONITOR_POLL_MS) || 2000;
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

// ---- 文件位置追踪 ----
const filePositions = new Map(); // filePath -> byte offset
const activeSkills = new Map();  // tool_use_id -> { skill, startedAt, sessionId, model }

async function getProjectDirs() {
  try {
    const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => path.join(PROJECTS_DIR, e.name));
  } catch {
    return [];
  }
}

function getJsonlFiles(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => path.join(projectDir, f));
  } catch {
    return [];
  }
}

async function scanAllJsonlFiles() {
  const dirs = await getProjectDirs();
  const files = [];
  for (const dir of dirs) {
    files.push(...getJsonlFiles(dir));
  }
  return files;
}

async function readNewLines(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    const prevPos = filePositions.get(filePath) || 0;

    if (stat.size <= prevPos) {
      if (stat.size < prevPos) filePositions.set(filePath, 0); // file was truncated
      return [];
    }

    const fd = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(stat.size - prevPos);
    await fd.read(buf, 0, buf.length, prevPos);
    await fd.close();

    filePositions.set(filePath, stat.size);

    const text = buf.toString("utf-8");
    return text.split("\n").filter(l => l.trim());
  } catch {
    return [];
  }
}

function isSkillStartEvent(d) {
  if (d.type !== "assistant") return false;
  const msg = d.message;
  if (!msg || typeof msg !== "object") return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  for (const c of content) {
    if (c && typeof c === "object" && c.name === "Skill" && c.input && c.input.skill) {
      return {
        skill: c.input.skill,
        args: c.input.args || "",
        toolUseId: c.id || "",
        model: msg.model || "unknown",
        sessionId: d.sessionId || "",
        timestamp: d.timestamp || new Date().toISOString(),
      };
    }
  }
  return null;
}

function isSkillEndEvent(d) {
  if (d.type !== "user") return null;
  const r = d.toolUseResult;
  if (!r || typeof r !== "object") return null;
  const cmd = r.commandName;
  if (!cmd) return null;
  return {
    commandName: cmd,
    success: r.success !== false,
    timestamp: d.timestamp || new Date().toISOString(),
    sessionId: d.sessionId || "",
    parentUuid: d.parentUuid || "",
  };
}

async function postEvent(event) {
  try {
    const url = `${DASHBOARD_URL}/api/events`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!resp.ok) {
      console.error(`[claude-monitor] POST failed: ${resp.status}`);
    }
    return resp.ok;
  } catch (err) {
    console.error(`[claude-monitor] POST error: ${err.message}`);
    return false;
  }
}

async function processLine(line, filePath) {
  try {
    const d = JSON.parse(line);

    // --- 检测 Skill 开始 ---
    const startInfo = isSkillStartEvent(d);
    if (startInfo) {
      console.log(`[claude-monitor] START  ${startInfo.skill}  session=${startInfo.sessionId.slice(0,8)} model=${startInfo.model}`);
      activeSkills.set(startInfo.toolUseId, {
        skill: startInfo.skill,
        startedAt: startInfo.timestamp,
        sessionId: startInfo.sessionId,
        model: startInfo.model,
        args: startInfo.args,
      });
      return;
    }

    // --- 检测 Skill 结束 ---
    const endInfo = isSkillEndEvent(d);
    if (endInfo) {
      console.log(`[claude-monitor] END    ${endInfo.commandName} success=${endInfo.success}`);

      // 尝试通过 parentUuid 匹配 start（parentUuid 是 start 事件的 uuid）
      let matchedStart = null;
      for (const [toolId, info] of activeSkills) {
        // 如果没有精确匹配，看 commandName 是否匹配 skill 名
        if (info.skill === endInfo.commandName) {
          matchedStart = { toolId, ...info };
          activeSkills.delete(toolId);
          break;
        }
      }

      if (matchedStart) {
        const startedAt = new Date(matchedStart.startedAt).getTime();
        const endedAt = new Date(endInfo.timestamp).getTime();
        const durationMs = endedAt - startedAt;

        const event = {
          skill: matchedStart.skill,
          status: endInfo.success ? "success" : "error",
          startedAt: matchedStart.startedAt,
          endedAt: endInfo.timestamp,
          durationMs: Math.max(durationMs, 0),
          source: "chat",
          sessionId: endInfo.sessionId,
          model: matchedStart.model,
          trigger: "manual",
          details: `CLI ${endInfo.success ? "OK" : "FAIL"}`,
        };

        await postEvent(event);
        console.log(`[claude-monitor] POST  ${event.skill} ${durationMs}ms ${event.status}`);
      } else {
        // 没有匹配到 start，但仍然上报（仅有结束时间）
        const event = {
          skill: endInfo.commandName,
          status: endInfo.success ? "success" : "error",
          endedAt: endInfo.timestamp,
          durationMs: 0,
          source: "chat",
          sessionId: endInfo.sessionId,
          model: "unknown",
          trigger: "manual",
          details: "end-only event",
        };
        await postEvent(event);
      }
      return;
    }

  } catch (err) {
    // JSON parse error — skip non-JSON lines
  }
}

async function scanRound() {
  const files = await scanAllJsonlFiles();

  for (const filePath of files) {
    // Initialize position for new files
    if (!filePositions.has(filePath)) {
      try {
        const stat = await fsp.stat(filePath);
        filePositions.set(filePath, stat.size);
      } catch {
        // file may have been deleted
      }
      continue;
    }

    const lines = await readNewLines(filePath);
    for (const line of lines) {
      await processLine(line, filePath);
    }
  }
}

async function main() {
  console.log("=".repeat(50));
  console.log("Claude Code Skill Monitor");
  console.log(`Watch dir: ${PROJECTS_DIR}`);
  console.log(`Dashboard: ${DASHBOARD_URL}`);
  console.log(`Poll: ${POLL_MS}ms`);
  console.log("=".repeat(50));

  // Initial scan: index all existing files without processing
  const initialFiles = await scanAllJsonlFiles();
  for (const f of initialFiles) {
    try {
      const stat = await fsp.stat(f);
      filePositions.set(f, stat.size);
    } catch { /* skip */ }
  }
  console.log(`Indexed ${initialFiles.length} existing session files (tail mode)`);

  // Start polling loop
  setInterval(scanRound, POLL_MS);
  console.log(`Monitoring started at ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error(`[claude-monitor] Fatal: ${err.message}`);
  process.exit(1);
});
