# ClaudeBoard

## 项目概述

零依赖的实时看板系统，用于监控 Claude Code / Codex 会话中的 Skill 调用和终端状态。包含两个独立 HTTP 服务和多个前端页面。

## 架构

### 服务端口

| 端口 | 服务 | 命令 |
|------|------|------|
| 3210 | **主看板** — Skill 调用统计、趋势、历史 | `npm start` / `node server.js` |
| 3211 | **Session 监控** — Claude Code 终端会话实时状态 | `npm run session:start` |

### 目录结构

```
skill-usage/
├── server.js                  # 主看板 HTTP 服务（零依赖）
├── package.json               # npm 脚本
├── SKILL.md                   # Skill 定义（给 Claude Code 用）
├── public/                    # 前端静态资源
│   ├── index.html             # 首页 — 技能排行 + 领奖台
│   ├── monitor.html           # 监控 — 运行时状态面板
│   ├── trends.html            # 趋势 — 时间线图表 + 调用明细
│   ├── history.html           # 历史 — 年度日历
│   ├── session-dashboard.html # 会话监控 — 终端状态看板
│   ├── styles.css             # 全局样式（CSS 变量，支持暗色模式）
│   ├── styles/                # 独立页面样式
│   │   └── session.css        # Session 监控页样式（含暗色模式）
│   ├── favicon.svg
│   └── scripts/
│       ├── dashboard-core.js  # 共享核心（i18n/主题/API/格式化）
│       ├── dashboard-models.js# 数据模型（排行/领奖台/摘要）
│       ├── home-page.js       # 首页渲染逻辑
│       ├── monitor-page.js    # 监控页渲染逻辑
│       ├── trends-page.js     # 趋势页渲染逻辑
│       ├── history-page.js    # 历史页渲染逻辑
│       └── session-card.js    # Session 卡片渲染组件
├── scripts/
│   ├── session-monitor.js     # Session 监控 HTTP 服务（端口 3211）
│   ├── claude-code-monitor.js # 监听 ~/.claude/projects/ 日志，上报 Skill 事件
│   ├── codex-log-monitor.js   # 监听 Codex session JSONL 并上报（被 codex-manager 管理）
│   ├── codex-manager.js       # Codex 跨平台安装/启动/停止管理器
│   ├── cli-alert.js           # CLI 实时告警工具（查询 API 输出异常）
│   ├── start-codex-monitor.{cmd,sh}
│   ├── stop-codex-monitor.{cmd,sh}
│   └── status-codex-monitor.{cmd,sh}
├── lib/
│   └── snapshot.js            # 聚合快照构建逻辑
├── tests/
│   ├── dashboard-api.test.js  # API 集成测试
│   ├── dashboard-models.test.js # 数据模型测试
│   ├── dashboard-pages.test.js  # 页面渲染测试
│   └── snapshot.test.js       # 快照构建测试
└── data/
    └── dashboard-process.json # 托管进程状态
```

## 关键实现细节

### 技术栈
- 纯 Node.js HTTP 服务（零 npm 依赖）
- 前端原生 JS + CSS（无框架）
- SSE（Server-Sent Events）实现实时推送
- JSONL 文件持久化

### 主题系统
- 琥珀暖橙 `#FFB74D` 作为品牌色，其他全用中性灰
- 通过 `html.dark` 类切换暗色模式
- 偏好存储在 localStorage `skill-usage-theme`
- 默认跟随系统 `prefers-color-scheme`

### 国际化
- 中/英双语，由 `dashboard-core.js` 管理
- 切换按钮在页面右上角
- 语言偏好存储在 localStorage `skill-usage-language`

### 数据流
1. Skill 事件通过 `POST /api/events` 写入
2. 主看板通过 `GET /api/stream` (SSE) 实时推送到前端
3. 持久化到 `CODEX_HOME/data/claude-board/claude-events.jsonl`
4. 时间范围切换：12h / 1d / 1m / 1y（按钮切换）

## 常用命令

```bash
# 启动主看板（3210）
npm start

# 启动 Session 监控（3211）
npm run session:start

# 启动 Claude Code 监控（自动上报 Skill 事件）
npm run claude:start

# 启动 Codex 监控
npm run codex:start

# 运行测试
npm test

# 注入演示数据（点击首页"注入演示数据"按钮 或 POST /api/demo/seed）
```

## Session 监控

`session-monitor.js`（端口 3211）提供：
- `GET /api/sessions` — 获取所有会话的实时快照
- `GET /api/sse` — SSE 推送会话状态变化
- `GET /api/session-timeline?sessionId=` — 获取指定会话的完整对话时间线
- `POST /api/ping` — Hook 心跳上报，辅助状态判定
- 监听 `~/.claude/projects/**/*.jsonl` 文件变化
- 推断状态：working / interrupt / waiting / idle / done（sub-agent 等待优先于空闲判定）
- 扁平卡片网格布局（无项目分组），支持按项目筛选、关键词搜索
- 点击卡片展开对话时间线详情弹窗
- 状态颜色自定义（⚙️ 设置面板，持久化到 localStorage）
- 暗色模式，跟随系统偏好或手动切换
- 空闲 > 2h 自动清理，完成 > 30min 自动清理
- `/rename` 标题持久化缓存，session 清理后不丢失

## Claude Code 监控

`claude-code-monitor.js` 监听 `~/.claude/projects/<project>/*.jsonl`，检测 Skill 调用：
1. 识别 assistant 消息中的 Skill 工具调用（START）
2. 匹配 user 消息中的 toolUseResult（END）
3. 计算耗时并 POST 到主看板 `/api/events`

## 配置项

### 主看板 (server.js)
| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3210 | 服务端口 |
| HOST | 127.0.0.1 | 绑定地址 |
| ENABLE_CODEX_MONITOR | 0 | 设为 1 时启动内嵌 Codex 监控 |
| CODEX_HOME | ~/.codex | Codex 主目录 |

### Session 监控 (session-monitor.js)
| 变量 | 默认值 | 说明 |
|------|--------|------|
| SESSION_PORT | 3211 | 服务端口 |
| HOST | 127.0.0.1 | 绑定地址 |

### Claude Code 监控 (claude-code-monitor.js)
| 变量 | 默认值 | 说明 |
|------|--------|------|
| DASHBOARD_URL | http://127.0.0.1:3210 | 看板地址 |
| CLAUDE_MONITOR_POLL_MS | 2000 | 轮询间隔 |

## 注意事项

- `data/` 目录下的 `dashboard-process.json` 已加入 `.gitignore`
- `logs/` 运行日志目录已加入 `.gitignore`
- 不要在 `server.js` 手动改端口，通过环境变量 `PORT` 配置
- Session 监控使用独立的 `public/styles/session.css`，已支持暗色模式
- 前端 CSS 是独立 `styles.css`，`session-dashboard.html` 使用独立的 `styles/session.css`
