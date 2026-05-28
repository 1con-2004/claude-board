const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");
const { startCodexLogMonitor } = require("./scripts/codex-log-monitor");
const { buildSnapshot, normalizeRange } = require("./lib/snapshot");

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SERVER_STARTED_AT = new Date().toISOString();
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const DATA_DIR = path.join(CODEX_HOME, "data", "claude-board");
const EVENTS_FILE = path.join(DATA_DIR, "claude-events.jsonl");
const PROCESS_STATE_FILE = path.join(ROOT_DIR, "data", "dashboard-process.json");
const STDOUT_LOG_FILE = path.join(DATA_DIR, "dashboard.stdout.log");
const STDERR_LOG_FILE = path.join(DATA_DIR, "dashboard.stderr.log");
const ENABLE_CODEX_MONITOR = process.env.ENABLE_CODEX_MONITOR === "1";

const sseClients = new Set();
let broadcastTimer = null;
let codexMonitor = null;

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };

  return types[extension] || "application/octet-stream";
}

function isPathInsideDirectory(parentDir, candidatePath) {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    await fsp.access(EVENTS_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(EVENTS_FILE, "", "utf8");
  }
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    error.statusCode = 400;
    error.message = "Request body must be valid JSON.";
    throw error;
  }
}

function toDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function clampDuration(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return metadata;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== "ESRCH";
  }
}

function normalizeEvent(rawEvent = {}) {
  const skill = typeof rawEvent.skill === "string" ? rawEvent.skill.trim() : "";

  if (!skill) {
    const error = new Error("Each event requires a non-empty string field named `skill`.");
    error.statusCode = 400;
    throw error;
  }

  const status = typeof rawEvent.status === "string" ? rawEvent.status.toLowerCase() : "success";
  const now = new Date();
  const startedAt = toDate(rawEvent.startedAt, now);
  let durationMs = clampDuration(Number(rawEvent.durationMs));
  let endedAt = rawEvent.endedAt ? toDate(rawEvent.endedAt, now) : null;

  if (!endedAt && durationMs > 0) {
    endedAt = new Date(startedAt.getTime() + durationMs);
  }

  if (endedAt && durationMs === 0) {
    durationMs = clampDuration(endedAt.getTime() - startedAt.getTime());
  }

  if (!endedAt) {
    endedAt = new Date(startedAt.getTime() + durationMs);
  }

  return {
    id: typeof rawEvent.id === "string" && rawEvent.id ? rawEvent.id : randomUUID(),
    skill,
    status: ["success", "error", "running"].includes(status) ? status : "success",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs,
    source: typeof rawEvent.source === "string" ? rawEvent.source : "unknown",
    sessionId: typeof rawEvent.sessionId === "string" ? rawEvent.sessionId : "default",
    model: typeof rawEvent.model === "string" ? rawEvent.model : "unknown",
    trigger: typeof rawEvent.trigger === "string" ? rawEvent.trigger : "manual",
    details: typeof rawEvent.details === "string" ? rawEvent.details : "",
    metadata: normalizeMetadata(rawEvent.metadata),
    createdAt: now.toISOString()
  };
}

async function appendEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const normalizedEvents = events.map(normalizeEvent);
  const payload = normalizedEvents.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await fsp.appendFile(EVENTS_FILE, payload, "utf8");
  scheduleBroadcast();
  return normalizedEvents;
}

async function readEvents() {
  const content = await fsp.readFile(EVENTS_FILE, "utf8");
  if (!content.trim()) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function getMonitorStatus(events) {
  if (!events) {
    try { events = await readEvents(); } catch { events = []; }
  }

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  // 检测 claude-code-monitor 进程
  let listenerPid = null;
  try {
    const pidFile = "/tmp/claude-code-monitor.pid";
    const raw = await fsp.readFile(pidFile, "utf8");
    const pid = Number(raw.trim());
    if (pid > 0 && isProcessAlive(pid)) {
      listenerPid = pid;
    }
  } catch {}
  if (!listenerPid) {
    try {
      const { execSync } = require("child_process");
      const out = execSync("pgrep -f 'claude-code-monitor\\.js'", { encoding: "utf8", timeout: 2000 }).trim();
      if (out) {
        const pids = out.split("\n").filter(Boolean).map(Number);
        listenerPid = pids.find(p => p !== process.pid) || null;
      }
    } catch {}
  }

  const claudeHome = path.join(os.homedir(), ".claude");
  const projectsDir = path.join(claudeHome, "projects");

  return {
    enabled: true,
    currentPid: process.pid,
    currentStartedAt: SERVER_STARTED_AT,
    codexHome: projectsDir,
    stdoutLogFile: "/tmp/claude-board-dashboard.log",
    stderrLogFile: "/tmp/claude-code-monitor.log",
    claude: {
      projectsDir: projectsDir,
      skillsDir: path.join(claudeHome, "skills"),
      dashboardLog: "/tmp/claude-board-dashboard.log",
      monitorLog: "/tmp/claude-code-monitor.log"
    },
    managed: {
      active: !!listenerPid,
      pid: listenerPid,
      port: null,
      host: null,
      startedAt: null,
      rootDir: projectsDir
    },
    runtime: lastEvent
      ? {
          startedAt: SERVER_STARTED_AT,
          lastPollAt: new Date().toISOString(),
          lastMatchedAt: lastEvent.endedAt || lastEvent.startedAt,
          lastFlushAt: new Date().toISOString(),
          matchedLines: events.length,
          emittedEvents: events.length,
          activeInvocations: 0,
          closed: false
        }
      : null
  };
}

async function getSnapshot(range = "12h") {
  const events = await readEvents();
  return {
    ...buildSnapshot(events, { range }),
    monitor: await getMonitorStatus(events)
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalizedPath = path.resolve(PUBLIC_DIR, relativePath);

  if (!isPathInsideDirectory(PUBLIC_DIR, normalizedPath)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(normalizedPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeTypeFor(normalizedPath),
      "Cache-Control": "no-store"
    });

    fs.createReadStream(normalizedPath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

async function broadcastSnapshot() {
  if (!sseClients.size) {
    return;
  }

  const payload = `event: snapshot\ndata: ${JSON.stringify(await getSnapshot("12h"))}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastSnapshot().catch((error) => {
      console.error("Failed to broadcast snapshot:", error);
    });
  }, 80);
}

function startFileWatcher() {
  fs.watch(EVENTS_FILE, { persistent: true }, () => {
    scheduleBroadcast();
  });
}

function generateDemoEvents(count = 80) {
  const skills = [
    "frontend-design",
    "openwiki",
    "webapp-testing",
    "doc-coauthoring",
    "pdf",
    "xlsx",
    "theme-factory",
    "mcp-builder"
  ];
  const models = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1-codex-mini"];
  const sources = ["chat", "api", "cli", "workflow"];
  const triggers = ["manual", "agent", "schedule", "retry"];

  return Array.from({ length: count }, (_, index) => {
    const skill = skills[Math.floor(Math.random() * skills.length)];
    const durationMs = Math.round(300 + Math.random() * 180000);
    const startedAt = new Date(Date.now() - Math.random() * 1000 * 60 * 60 * 24 * 320);
    const endedAt = new Date(startedAt.getTime() + durationMs);
    const failed = Math.random() > 0.88;

    return {
      id: `demo-${Date.now()}-${index}-${randomUUID().slice(0, 8)}`,
      skill,
      status: failed ? "error" : "success",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      source: sources[Math.floor(Math.random() * sources.length)],
      sessionId: `session-${1 + Math.floor(Math.random() * 12)}`,
      model: models[Math.floor(Math.random() * models.length)],
      trigger: triggers[Math.floor(Math.random() * triggers.length)],
      details: failed ? "rate limit / retry path" : "completed end-to-end",
      metadata: {
        promptTokens: Math.round(80 + Math.random() * 2500),
        completionTokens: Math.round(60 + Math.random() * 4000)
      }
    };
  });
}

async function handleApi(req, res, pathname, url) {
  if (req.method === "GET" && pathname === "/api/stats") {
    const range = normalizeRange(url.searchParams.get("range") || "12h");
    sendJson(res, 200, await getSnapshot(range));
    return;
  }

  if (req.method === "POST" && pathname === "/api/events") {
    const body = await parseJsonBody(req);
    const events = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
    const created = await appendEvents(events);
    sendJson(res, 201, { ok: true, created });
    return;
  }

  if (req.method === "POST" && pathname === "/api/demo/seed") {
    const count = Math.max(1, Math.min(500, Number(url.searchParams.get("count")) || 80));
    const created = await appendEvents(generateDemoEvents(count));
    sendJson(res, 201, { ok: true, seeded: created.length });
    return;
  }

  if (req.method === "GET" && pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });

    res.write(": connected\n\n");
    sseClients.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(await getSnapshot("12h"))}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      res.end();
    });
    return;
  }

  sendJson(res, 404, { error: "Unknown API route." });
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, url);
      return;
    }

    await serveStatic(res, pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, { error: error.message || "Unexpected server error." });
  }
}

async function start() {
  await ensureStorage();
  startFileWatcher();

  if (ENABLE_CODEX_MONITOR) {
    codexMonitor = startCodexLogMonitor({
      appendEvents,
      logger: console
    });
  }

  const server = http.createServer(requestHandler);
  server.listen(PORT, HOST, () => {
    console.log(`ClaudeBoard running at http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exitCode = 1;
});
