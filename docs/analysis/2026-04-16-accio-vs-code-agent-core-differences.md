# Accio Work vs Code Agent 核心模块差异分析

日期：2026-04-16
状态：进行中

## 当前稳定结论

### 1. Multi-agent 的本质差异

当前最稳定的判断是：

- `Accio Work` 是 `chat-native multi-agent`
- `code-agent` 是 `orchestration-native multi-agent`

这不是视觉风格差异，而是产品交互模型差异。

### 2. 为什么 Accio 的 multi-agent 更像“给普通用户用”

`Accio Work` 把多代理做成了一等聊天对象：

- 先创建 `team`
- 用户直接在主聊天里发送第一条任务
- `team 创建 / session 创建 / 首条消息发送` 被融合成一个动作
- 通过 `@agent` 做任务路由
- 回放、分配、执行状态都回到聊天线程里表达

所以用户心智是：

`我在和一个团队聊天`

而不是：

`我在操作一个并行编排系统`

### 3. code-agent 当前的真实模型

`code-agent` 也有真实多代理能力，但主抽象不是 team chat，而是：

- `CoworkContract`
- `executionRules`
- `launch approval`
- `swarm/orchestration panel`

用户路径更像：

`我在主会话里发任务 -> 系统弹出并行编排 -> 我批准启动 -> 右侧面板监控 agent`

所以它更像：

`监督一个并行执行系统`

而不是：

`直接和一个 agent 团队协作`

### 4. 对 code-agent 的直接启发

如果目标是把多代理体验拉近 Accio，优先级应该是：

1. 把 `swarm launch approval` 变成主聊天中的内联卡片，而不是主要依赖右侧 `TaskPanel`
2. 把对 agent 的路由变成主输入框里的原生能力，例如 `@agent` / agent chips
3. 把 swarm 的关键事件投影回 turn 内，而不是主要依赖 sidecar 监控面板

结论：

`code-agent` 现在的差距主要在产品壳，不在 orchestration 引擎本身。

## 已确认的证据点

### Accio Work

- team 创建与 pending chat 融合，首条消息驱动真实 team/session 建立
- group chat 发送链路有 `chatType: "group"`、`atIds`、`targetAgentList`
- replay 能识别 subagent / sessions_spawn / sessions_send
- subagent session 有独立持久化

### code-agent

- `CoworkContract` 以角色、依赖、并行组定义多 agent 协作
- `CoworkOrchestrator` 按 stage 执行并聚合结果
- swarm 启动前走 `launch approval`
- 前端入口主要落在 `TaskPanel -> orchestration`
- `AgentTeamPanel` 提供的是“对已运行 agent 发消息”的侧边通信能力
- `SessionStateManager` 维护的是 `session -> activeSubagents`

## 下一步

接下来继续比较这些模块：

- browser / computer use
- connectors / channels
- workspace / local execution
- automation / scheduled tasks
- MCP / skills / plugins
- observability / replay

## 本轮补充结论

### 5. Browser / Computer Use

`Accio Work` 的浏览器能力更像聊天内显式引导：

- 先在对话里识别“需要浏览器连接”
- 给出扩展安装与连接卡片
- 接入用户已有 Chrome 标签页
- 连上后继续原任务

`code-agent` 的 browser / computer-use 更像工具层隐式触发：

- 用户先发普通消息
- agent 再决定是否调用 browser/computer 工具
- 前端主要显示工具执行状态
- 用户不会先进入一个单独的“浏览器接入”心智

判断：

`Accio` 在 browser/computer-use 上更像面向普通用户的产品链路；`code-agent` 更像能力完整但入口更工程化的工具系统。

### 6. Connectors / Channels / Pairings

`Accio Work` 把外部渠道和外部人直接接进 team chat：

- paired users 会作为 `channelMembers` 进入 team
- 这些成员的 DM 会被绑定回 team 会话
- connectors 也直接进入同一次 group send payload

`code-agent` 的 channel / connector 更偏独立入口：

- channel message 默认映射成独立 session
- connector 主要是本地 registry + tool modules
- multi-agent 和 channels/connectors 仍是两条平行链路

判断：

在“把外部世界接入 agent 团队”这件事上，`Accio` 明显更产品化。

### 7. Workspace / Local Execution / MCP / Skills / Plugins

`Accio Work` 已经把这些能力收成一个统一 workbench：

- `workspace / connectors / skills / plugins` 都是并列产品模块
- 会话发送链能同时带上工作目录、文件搜索、skills/plugins、connectors
- MCP 在产品上被表现为前台 connectors，而不是后台设施

`code-agent` 这些底层能力大多都在：

- workspace 有 store / IPC / UI
- 本地执行有 toolExecutor 与 bridge
- MCP、skills、plugins 也各有后端与 UI

但它们分散在不同入口里，主聊天链路没有把这些选择收成同一次显式 payload。

判断：

`Accio` 更像完整的 agent workbench；`code-agent` 更像底层能力已到位、但入口尚未收口的 agent runtime。

### 8. Automation / Replay / Observability

`Accio Work` 的自动化和可观察性是聊天原生的：

- scheduled tasks 是主导航一级能力
- cron 结果会直接回流到普通聊天流
- replay / debugability 嵌在聊天体验里

`code-agent` 的 observability 明显更偏控制台：

- swarm monitor / orchestration / task status 是独立状态条与任务面板
- trace 是持久化、分层、可追责的运行时观测体系
- 更适合工程操作员排查与追踪

判断：

`Accio` 的 observability 是“把可见性揉进聊天用户流”，`code-agent` 的 observability 是“把执行运行时抽成独立控制面”。
