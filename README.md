# ClaudeBoard

零依赖的实时看板系统，用于监控 Claude Code / Codex 会话中的 Skill 调用指标和终端状态。

## 功能特性

### 主看板（端口 3210）
- **首页** — 技能排行领奖台、调用次数/成功率/平均耗时概览、实时动态流
- **监控** — 运行时状态面板（监听状态、PID、日志路径、最近调用）
- **趋势** — 时间线柱状图、调用明细表格（可按范围/技能聚焦）
- **历史** — 年度日历热力图、活跃天数/最长连续记录统计
- 基于 SSE 的实时更新，无需手动刷新
- JSONL 持久化，方便接入外部工具
- 中/英双语界面
- 暗色模式支持（跟随系统或手动切换）
- 支持注入演示数据测试

### Session 监控（端口 3211）
- 实时跟踪所有 Claude Code 终端会话状态（working / interrupt / idle / done）
- 按项目分组展示，支持拖拽排序
- SSE 推送实时状态变化
- 自动清理过期会话（idle > 2h / done > 30min）

### 监控采集器
- **Claude Code 监控** — 监听 `~/.claude/projects/` 日志文件，自动检测 Skill 调用并上报
- **Codex 监控** — 监听 Codex session JSONL，跨平台管理（Windows / Ubuntu）

## 快速开始

```bash
# 安装依赖（零 npm 依赖，仅需 Node.js）
npm install

# 启动主看板
npm start
# 打开 http://127.0.0.1:3210

# 启动 Session 监控（另一终端）
npm run session:start
# 打开 http://127.0.0.1:3211/session-dashboard.html

# 启动 Claude Code 技能事件自动上报
npm run claude:start
```

## API 接口

### 主看板（端口 3210）
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/stats?range=12h` | GET | 返回聚合统计快照 |
| `/api/events` | POST | 写入一条或多条事件 |
| `/api/stream` | GET | SSE 实时更新流 |
| `/api/demo/seed?count=N` | POST | 注入 N 条随机演示数据 |

### Session 监控（端口 3211）
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | GET | 返回所有会话实时快照 |
| `/api/sse` | GET | SSE 推送会话状态变化 |

## 事件格式

向 `/api/events` 发送 POST：

```json
{
  "skill": "frontend-design",
  "status": "success",
  "startedAt": "2026-04-01T08:20:00.000Z",
  "endedAt": "2026-04-01T08:20:05.600Z",
  "durationMs": 5600,
  "source": "chat",
  "sessionId": "session-42",
  "model": "claude-sonnet-4-6",
  "trigger": "manual",
  "details": "completed end-to-end",
  "metadata": { "promptTokens": 1200, "completionTokens": 800 }
}
```

## 配置项

### 主看板
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3210 | 服务端口 |
| `HOST` | 127.0.0.1 | 绑定地址 |
| `ENABLE_CODEX_MONITOR` | 0 | 设为 1 时开启内嵌 Codex 日志监控 |
| `CODEX_HOME` | `~/.codex` | Codex 主目录 |

### Session 监控
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SESSION_PORT` | 3211 | 服务端口 |
| `HOST` | 127.0.0.1 | 绑定地址 |

### Claude Code 监控
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHBOARD_URL` | http://127.0.0.1:3210 | 主看板地址 |
| `CLAUDE_MONITOR_POLL_MS` | 2000 | 日志轮询间隔 |

## 测试

```bash
npm test
```

包含 API 集成测试、数据模型测试、页面渲染测试和快照构建测试。
