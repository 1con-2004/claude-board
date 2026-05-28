---
name: claude-board
description: Real-time dashboard for Claude Code skill analytics and terminal session monitoring. Use this skill when users want to monitor skill usage, visualize skill call metrics, debug skill performance issues, track Claude Code terminal sessions, or integrate skill telemetry into their workflow. The dashboard auto-updates via SSE and persists events to JSONL for external analysis.
---

# ClaudeBoard

Zero-dependency real-time dashboard for monitoring skill invocations across Claude Code and Codex sessions, plus terminal session status tracking.

## Quick Start

```bash
# Start main dashboard (port 3210)
npm start

# Start session monitor (port 3211, another terminal)
npm run session:start

# Start Claude Code skill event auto-detection
npm run claude:start
```

- Main dashboard: http://127.0.0.1:3210
- Session monitor: http://127.0.0.1:3211/session-dashboard.html

## Architecture

Two independent HTTP servers:

| Port | Service | Description |
|------|---------|-------------|
| 3210 | Main Dashboard | Skill usage stats, trends, history, monitor |
| 3211 | Session Monitor | Claude Code terminal session live status |

## Frontend Pages

| Page | Route | Description |
|------|-------|-------------|
| Home | `/` | Skill leaderboard, summary cards, live feed |
| Monitor | `/monitor.html` | Runtime status panel |
| Trends | `/trends.html` | Timeline chart + call details table |
| History | `/history.html` | Year calendar heatmap |
| Session | `/session-dashboard.html` (3211) | Terminal session status by project |

## Features

- Real-time SSE updates, no page refresh needed
- Skill aggregation: calls, avg/P95/max duration, success/error rates
- 24-hour / 1-day / 1-month / 1-year timeline buckets
- Source breakdown (chat/api/cli/workflow) and model distribution
- Dark mode with CSS variables, follows system preference
- i18n: Chinese / English
- JSONL persistence for external tooling integration
- Claude Code session log auto-detection
- Codex sessions auto-monitor

## API Endpoints

### Main Dashboard (port 3210)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats?range=` | Aggregated statistics snapshot |
| POST | `/api/events` | Write one or more skill events |
| GET | `/api/stream` | SSE real-time update stream |
| POST | `/api/demo/seed?count=N` | Inject N random demo events |

### Session Monitor (port 3211)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | All session live snapshot |
| GET | `/api/sse` | SSE session state changes |

## Key Implementation Notes

- All CSS uses CSS custom properties with amber brand color (`#FFB74D`)
- Dark mode toggled via `html.dark` class, persisted in localStorage
- The 4 main pages share `/styles.css`; `session-dashboard.html` has its own inline `<style>`
- `dashboard-core.js` is the shared module (i18n, theme, formatting, API helpers)
- Session monitor watches `~/.claude/projects/**/*.jsonl` for file changes
- Claude Code monitor detects Skill tool calls from session logs and POSTs to `/api/events`

## Configuration

### Main Dashboard (server.js)
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3210 | Server port |
| HOST | 127.0.0.1 | Bind address |
| ENABLE_CODEX_MONITOR | 0 | Enable built-in Codex log watcher |
| CODEX_HOME | ~/.codex | Codex home directory |

### Session Monitor (session-monitor.js)
| Variable | Default | Description |
|----------|---------|-------------|
| SESSION_PORT | 3211 | Server port |
| HOST | 127.0.0.1 | Bind address |
