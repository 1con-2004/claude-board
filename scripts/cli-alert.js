#!/usr/bin/env node
/**
 * ClaudeBoard CLI 实时推送
 *
 * 查询看板 API，输出异常提醒和活跃概况。
 * 用法: node cli-alert.js [--watch]
 */

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:3210";

// ANSI 颜色
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function icon(status) {
  if (status === "error") return "❌";
  if (status === "warn") return "⚠️ ";
  if (status === "ok") return "✅";
  if (status === "info") return "ℹ️";
  if (status === "fire") return "🔥";
  if (status === "up") return "📈";
  if (status === "sleep") return "💤";
  return "";
}

async function fetchJSON(path) {
  const resp = await fetch(`${DASHBOARD_URL}${path}`);
  if (!resp.ok) throw new Error(`API ${resp.status} ${resp.statusText}`);
  return resp.json();
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m${sec}s`;
}

function fmtPct(v) {
  return `${(v * 100).toFixed(0)}%`;
}

async function runAlert() {
  let stats;
  try {
    stats = await fetchJSON("/api/stats");
  } catch (err) {
    console.error(`${C.red}${C.bold}✖ 无法连接看板${C.reset}`);
    console.error(`  ${C.gray}${DASHBOARD_URL}/api/stats${C.reset}`);
    console.error(`  ${C.gray}${err.message}${C.reset}`);
    console.error(`  ${C.gray}看板是否已启动？运行 ClaudeBoard start${C.reset}`);
    process.exit(1);
  }

  const summary = stats.summary || {};
  const skills = stats.skills || [];

  const hasData = summary.totalCalls > 0;

  // ─── 头部 ───
  const line = "─".repeat(48);
  console.log(`\n${C.bold}${C.cyan}  ClaudeBoard 实时状态${C.reset}`);
  console.log(`  ${C.gray}${line}${C.reset}`);

  if (!hasData) {
    console.log(`  ${C.gray}暂无数据，等待第一笔 skill 调用...${C.reset}\n`);
    return;
  }

  // ─── 总览 ───
  const successRate = summary.successRate != null ? `${summary.successRate}%` : "--";
  const errRate = summary.errorRate != null ? `${summary.errorRate}%` : "--";
  console.log(
    `  ${C.bold}总览${C.reset}` +
    `  调用 ${C.cyan}${summary.totalCalls}${C.reset}` +
    `  · 成功率 ${summary.successRate === 100 ? C.green : C.yellow}${successRate}${C.reset}` +
    `  · 失败率 ${summary.errorRate > 0 ? C.red : C.gray}${errRate}${C.reset}` +
    `  · Skill ${C.cyan}${summary.uniqueSkills}${C.reset} 个`
  );

  // ─── 异常提醒 ───
  const alerts = [];

  for (const sk of skills) {
    const name = sk.skill;
    const calls = sk.calls || 0;
    const errors = sk.errors || 0;
    const failRate = sk.failureRate || 0;
    const p95 = sk.p95DurationMs || 0;

    if (errors > 0 && failRate > 0) {
      alerts.push({
        type: "error",
        text: `${icon("error")}  ${C.red}${C.bold}${name}${C.reset} ${C.red}失败 ${errors}/${calls}${C.reset} (${fmtPct(failRate)})`,
      });
    }

    if (p95 > 30000) {
      alerts.push({
        type: "warn",
        text: `${icon("warn")}  ${C.yellow}${name}${C.reset} P95 ${C.yellow}${fmtMs(p95)}${C.reset} · 响应偏慢`,
      });
    }
  }

  if (alerts.length > 0) {
    console.log(`\n  ${C.bold}${alerts.some(a => a.type === "error") ? C.red : C.yellow}异常提醒${C.reset}`);
    console.log(`  ${C.gray}${line}${C.reset}`);
    for (const a of alerts) {
      console.log(`  ${a.text}`);
    }
  } else if (hasData) {
    console.log(`\n  ${icon("ok")}  ${C.green}一切正常，无异常提醒${C.reset}`);
  }

  // ─── 活跃排行 ───
  const ranked = [...skills].sort((a, b) => (b.calls || 0) - (a.calls || 0));
  const top = ranked.slice(0, 5);

  console.log(`\n  ${C.bold}活跃排行${C.reset}`);
  console.log(`  ${C.gray}${line}${C.reset}`);
  for (const sk of top) {
    const name = sk.skill;
    const calls = sk.calls || 0;
    const avg = sk.avgDurationMs || 0;
    const errs = sk.errors || 0;
    const errTag = errs > 0 ? ` ${C.red}✖${errs}${C.reset}` : "";
    console.log(`  ${calls > 10 ? icon("fire") : icon("up")}  ${C.cyan}${name}${C.reset}  ${calls}次  ${C.gray}均 ${fmtMs(avg)}${C.reset}${errTag}`);
  }

  // ─── 低活 Skill ───
  const lowActivity = ranked.slice(3).filter(sk => (sk.calls || 0) <= 2);
  if (lowActivity.length > 0) {
    console.log(`\n  ${C.bold}${C.gray}低频 Skill${C.reset}`);
    console.log(`  ${C.gray}${line}${C.reset}`);
    for (const sk of lowActivity) {
      console.log(`  ${icon("sleep")}  ${C.gray}${sk.skill}${C.reset}${C.dim} 仅 ${sk.calls || 0} 次${C.reset}`);
    }
  }

  console.log();
}

// ─── --watch 模式 ───
const args = process.argv.slice(2);
if (args.includes("--watch") || args.includes("-w")) {
  const interval = 30000; // 30s
  console.log(`${C.gray}每 ${interval/1000}s 刷新一次（Ctrl+C 退出）${C.reset}`);
  runAlert().then(() => {
    setInterval(runAlert, interval);
  });
} else {
  runAlert();
}
