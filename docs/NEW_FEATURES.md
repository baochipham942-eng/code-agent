# Code Agent 新功能说明

## 概览

截至 2026-05-14，当前主线新增能力已经从早期“多模型 / 云端 / GUI Agent”推进到 agent runtime hardening、workbench、live preview、browser/computer、activity context、native tool protocol、artifact acceptance、quality gates、prompt/hook 管理、prompt rewind、自定义 Agent / 权限继承 / Doctor 诊断，以及最新一轮的 Context Health 溯源 / 取消级联 / Computer-use MCP 入口归位 / 工作台诊断面板群：

1. **Agent Runtime Capability Hardening** - run lifecycle、run-level abort、Tool/MCP 权限合同、durable runtime state、multiagent reliability、real-agent-run eval gate
2. **Chat-Native Workbench B+** - ChatInput 极简化、右侧 WorkbenchTabs、Settings 对话 tab、Sidebar User Menu、semantic tool UI
3. **Live Preview V2** - Vite-only devServerManager、click-to-source、TweakPanel、bridge protocol 0.3.0、Next.js 支持延期
4. **Browser / Computer Workbench** - in-app managed browser 的 session/profile/account/artifact/lease/proxy/TargetRef，Computer Surface background AX / CGEvent
5. **Activity Providers** - OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis 统一成 ActivityContext
6. **Native Tool Protocol Migration** - Web/Search、Excel、Document、MCP、Skill、LSP、Multiagent、Planning、Vision、Network/Media/Docgen/PPT 原生化，旧 wrappers 分批退场
7. **Runtime / Web / Context Hardening** - Web REST session、telemetry classifier、context fill、assistant persistence、failure-mode loop breaker
8. **Artifact Acceptance / Repair** - Game subtype、DeckVerifier、DashboardVerifier、Best-of-N、repair cap、anti-Potemkin probes
9. **Quality Gates** - typed IPC、zod provider wrappers、provider symmetry、async correctness、god-file split、dead code retirement
10. **Prompt / Hook 管理** - Prompt Manager 实时 override、Hook Settings tab、CLI hooks 默认启用、聊天 TurnCard 展示 Hook Activity
11. **Prompt Rewind** - 回到历史用户提示词、恢复文件 checkpoint、隐藏旧 active 消息、保留 `session_rewinds` 审计

早期更新增加了以下核心功能：

1. **多模型 SDK 支持** - 支持 DeepSeek、Claude、OpenAI、Groq、本地模型
2. **云端 Agent（历史，已退役）** - 早期 Vercel Serverless 方案，当前 active path 已迁回本地 / Web runtime
3. **GUI Agent** - 基于 Claude Computer Use 的屏幕控制能力
4. **macOS 签名打包** - 完整的代码签名和公证配置

---

## 2026-05-13 ~ 2026-05-14 当前新增能力

### Context Health / Token 来源溯源

| 能力 | 说明 |
|------|------|
| Token bySource 维度 | `TokenBreakdown` 在消息结构维度之外新增 `bySource`，按 rules / skills / mcp / subagents / fileReads / conversation 六类拆分上下文 token 占用 |
| 来源上报 | skill mount/unmount、SessionStart AGENTS.md 注入、fileRead、MCP 工具结果、subagent 输出统一调用 `ContextHealthService.recordSourceContribution` 上报，200ms 防抖广播到 UI |
| Context Panel | workbench 新增 `context` tab，一级展开按消息结构、二级展开按产品来源，Skills/MCP/Subagents 可嵌套折叠 |
| 跳转与卸载 | 每项可跳转（联动 SkillsPanel highlight）或 ✕ 卸载（MCP 走 `setServerEnabled` IPC，skill 走 unmount），卸载后影响下一轮上下文构建 |

### 取消级联（Cancellation Cascading）

| 能力 | 说明 |
|------|------|
| CancellationReason 契约 | 取消原因分 CASCADE（user-cancel / session-switch / parent-cancel，向下穿透）和 NON_CASCADE（child-error / timeout / idle-timeout / budget-exceeded，只熔断单 agent） |
| 四阶段 Shutdown | `initiateShutdown` 走 Signal → Grace（5s 等工具收尾）→ Flush（2s 持久化 findings）→ Force（返回 partial results） |
| Idle watchdog | 子 agent 2 分钟无 stream/progress 自动 `abort('idle-timeout')`，每 5s 轮询 |
| Per-agent Stop UI | SwarmMonitor 每个 agent 卡片可独立 Stop，走 `swarm:cancel-agent` IPC，取消单 agent 不级联兄弟 |
| 父子信号桥接 | `createChildAbortController` 把 parent abortSignal 与内部 timeout 单向桥接到子控制器，child abort 不反向传播 |

### Computer-use MCP 入口归位 + 工作台诊断面板群

| 能力 | 说明 |
|------|------|
| Computer / Screenshot MCP 入口归位（Level 1） | Computer + Screenshot 暴露成独立 native ToolModule，统一走 MCP 工具入口；当前是 wrapper-mode，执行仍委托 legacy ComputerTool，为 Level 2 原生重写留接口 |
| Computer-use 诊断 | 工作台追踪 computer use 的渲染状态、权限、失败原因和目标应用状态 |
| 知识记忆审计面板 | 展示数据库 memory + 轻记忆文件 + 种子候选，metadata（工具偏好、编码风格等）格式化展示 |
| 活动入口面板 | 从 OpenChronicle / native desktop / audio / screenshot-analysis 多源采集活动快照，受 char limit 和敏感数据守护约束 |
| 时间能力工作台 | MCP / DAG / service / interaction 超时策略集中到 `timeouts.ts`，可查询当前 timeout 配置 |
| Workspace Assets | 聊天里露出 Document / Spreadsheet / PPT / HTML 等工作区产物，支持快速导航活动中提及的文件 |

### Runtime Steer / Vision / Prompt Rewind

| 能力 | 说明 |
|------|------|
| Runtime Steer 排队 | 运行中途用户输入经 `injectSteerMessage` 排队进当前轮次消息历史，置 `needsReinference` 下轮推理；guided UI 标记 `queued_next_turn` 让用户知道输入已收到 |
| Web host follow-up | web 端运行中 follow-up 带 `clientMessageId`，让消息拥有稳定标识供 prompt rewind 溯源 |
| Vision 模型切换 | 视觉模型切到免费档 `glm-4.1v-thinking-flash`（带推理链），8 个视觉模块统一从 `ZHIPU_VISION_MODEL` 常量读取 |
| 工作目录边界澄清 | 系统提示新增工作目录边界说明：工作目录是相对路径基准而非任务边界，系统级查询可访问 home 绝对路径，续接指令保留上文任务作用域 |

### Channel / 本地活动隐私防火墙

| 能力 | 说明 |
|------|------|
| 通道隐私防火墙 | 渠道入站消息、附件、raw payload 在本地落地/分发前统一脱敏；`ChannelPrivacyMode` 三档：`local-redact`（默认）/ `allow-raw`（保留 raw 便于连接器调试）/ `off`（仅受控本地调试）；飞书渠道已接入，每个通道可在设置里单独配置 |
| 本地活动脱敏 | `DesktopActivityEvent` 字段（appName / windowTitle / browserUrl / documentPath / analyzeText 等）在 `NativeDesktopService` 解析每行事件时脱敏；视觉分析的 analyze-text 写回 SQLite 前脱敏 |
| 截图像素级脱敏 | `screenshotPrivacyRedactor` 从事件元数据提取 explicit/OCR 脱敏区域（多格式 bbox 解析 + 归一化坐标识别），用 sharp 做区域级 blur；analyze-text 敏感但无区域时降级为整帧 blur |
| 确定性 PII 脱敏 | `sensitiveDataGuard` 补 US SSN 和信用卡（Luhn 校验）确定性脱敏，接入共享 `guardSensitiveText` 入口 |
| Rust 侧对称脱敏 | `native_desktop.rs` 在采集边界镜像同一套脱敏：剥离 URL 凭证/query/fragment、home 路径、email、信用卡 Luhn，保证 Rust 采集器与 TS guard 同一脱敏契约 |

---

## 2026-05-11 当前新增能力

### Prompt / Hook / Prompt Rewind

| 能力 | 说明 |
|------|------|
| Prompt Manager | Sidebar User Menu 进入提示词管理器，按 category 查看默认文本与当前生效文本，支持保存、复制、恢复默认 |
| Prompt override | 保存到 `~/.code-agent/prompts-overrides/<id>.md`，`applyOverride()` + `dynamic()` 让下一轮 system prompt 构建立即读取新文本 |
| Hook Settings | 设置 → 能力与连接 → Hook，展示 enabled / unused events、matcher、source、decision/observer、parallel，并可打开/定位配置文件 |
| Hook Activity in Chat | Hook trigger history 汇入 turn timeline，TurnCard 展示本轮 hook 数量、allow/block、改写输入、错误和耗时 |
| CLI hooks | CLI `enableHooks` 默认打开，不再只跟 planning mode 绑定 |
| Chat workspace defaults | 新建会话与新 tab 默认进 Chats bucket；TitleBar 选择目录会写回当前 session |
| Prompt Rewind | `rewindToPrompt` 恢复最近文件 checkpoint，隐藏锚点提示及之后 active 消息，把原 prompt 和附件回填输入框 |
| Rewind audit | `messages.visibility` 与 `session_rewinds` 保留完整审计；Supabase 迁移同步云端字段和 RLS |

---

## 2026-05-01 ~ 2026-05-10 当前新增能力

### Native Tool Protocol Migration

| 能力 | 说明 |
|------|------|
| Wave 1 | search / skill / LSP 迁到 Level 1 native protocol；LSP 支持 100+ extension map、npm server 自动安装、失败返回 install hint |
| Wave 2 | document / excel / MCP 迁到 native dispatcher，旧 `tools/mcp/` legacy path 删除 |
| Wave 3 | multiagent / planning 工具迁到 native protocol，`spawn_agent / send_input / wait_agent / close_agent / plan_* / task_*` 提取 schema 并清掉 wrappers |
| Wave 4 | vision / network / media / docgen / PPT 迁到 native protocol，Computer / Browser / screenshot / image/video/speech/pdf/ppt/excel/docx 等能力按模块进 registry |
| WebFetch contract | WebFetch 必须显式传 URL；search/fetch loop guidance 收紧，减少无 URL 抓取和反复搜索 |
| Edit reliability | `old_text` mismatch 时提示最近 anchor lines，帮助模型下一轮改准位置 |
| Migration SOP | `docs/migrations/legacy-tools-removal-sop.md` 汇总 wave1-4 lessons，后续迁移按 schema → registry → legacy drop → tests 执行 |

### Runtime / Web / Context Hardening

| 能力 | 说明 |
|------|------|
| Compaction recovery | compact-current、tool-call hydrate、agent-error helper 接入 contextHealth，浏览器恢复路径也纳入同一诊断面 |
| Partial failure trace | chat trace 能显示 partial failure，并把 active turn 自动滚入视图 |
| Web session 修复 | local auth token mismatch 401/403 recovery、run 前持久化 user message、model session override、REST path flush 统一到 activeAgentLoops |
| Telemetry closure | structured error classifier、intent extension、turn auto-finalize、token-trigger compaction 合流 |
| Context fill estimate | tool schemas token 纳入上下文占用估算 |
| Failure-mode loop | anti-scraping hint、stagnation detector、ground-truth gate、重复后断环，降低无效搜索/抓取循环 |
| Assistant persistence | assistant messages 可靠落库，reload / replay 不再只靠 live stream |
| 中文长度约束 | complexity analyzer 能识别中文输出长度要求 |

### Browser / Computer 多 Agent 隔离

| 能力 | 说明 |
|------|------|
| Per-agent BrowserService | Agent Team 调 Browser/BrowserAction/BrowserNavigate/Screenshot 时带 `agentId`，路由到独立 BrowserService |
| Cookie/storage 隔离 | 真实 Chromium smoke 证明子 agent 的 cookie / localStorage 不串号 |
| Ephemeral launch cap | 临时 Chromium 启动用 FIFO semaphore 限流 |
| ComputerSurface mutex | type/click/key/clipboard 等写动作串行化，减少多 agent 抢输入 |
| 新 computer 原语 | `mouse_down/up`、`open_application`、`write_clipboard`、`computer_batch`、`hold_key`、`triple_click`、`cursor_position` |
| Agent mode switch | multi-agent 模式支持 targetApp screenshot crop 和 escalated warning |
| Signal / context | `agentId` 从 subagent dispatch 注入 ToolContext；`effectiveSignal` 透传给 `modelRouter.inference` |

### Frontend Execution Rails / Workspace Preview

| 能力 | 说明 |
|------|------|
| Run Status Rail | Chat 顶部在后台任务、队列或 Agent Team 活跃时展示 running/queued、活跃 session、swarm chip 和进度，可跳转 session 或打开 TaskPanel/Agent Team |
| TaskPanel task rail | TaskPanel 收敛成 task-first 状态工作面，过滤工具性步骤，只露出当前动作、检查项、产物、approval、outputs、context、MCP、memory 和待审项 |
| Workspace Preview review | Workspace Preview 从 artifact 预览升级为 review workbench，支持 Delivery Review、Preview Feedback、resolve/dismiss、send back to chat |
| Design PPT preview | `design_ppt` artifact 专用预览，展示 slides、theme、iterations、截图网格、prompt/code path，并提供 Open PPTX / Edit code |

### Artifact Acceptance / Repair

| 能力 | 说明 |
|------|------|
| Repair toolkit | 泛化 issue code、repair instruction、scope guard、prompt limit、monotonic baseline 等 repair loop 模式 |
| Game subtype | platformer 逻辑迁到 subtype-dispatch architecture；runner subtype 验证扩展性；scope guard 自注册 |
| Best-of-N | repair cap + monotonicity gate 避免无限修和越修越差 |
| DeckVerifier | schemaProbe + declarative / imperative narrative probes + GeneralDeckChecker + baseline harness；`pptGenerate` 已接入 |
| Deck live mode | `deck-generation.ts --live` 支持外部产品跑 acceptance |
| DashboardVerifier | scaffold + declarative HTML probes + browser visual smoke + `state_change_on_click` anti-Potemkin probe |
| ADR-016 | 不强行抽 cross-kind verifier interface，Game / Deck / Dashboard 保持各自输入形态 |

### Quality Gates / Cleanup

| 能力 | 说明 |
|------|------|
| Config 单源 | `IReadConfigService` 让 CLI / webServer 共享 main ConfigService |
| Typed IPC | `shared/ipc` zod schema、`defineHandler`、renderer `typedInvoke`、web `parseBody` 开始收口 payload 类型 |
| Provider wrappers | OpenAI / Anthropic / DeepSeek / Gemini 解析走 zod wrappers；SSE stream 切到 wrappers；51 fixtures contract tests |
| Provider symmetry | provider symmetry script 接入 Husky + GitHub Actions，volcengine / grok 补进 supported providers |
| Async correctness | `Promise.race` → `withTimeout`，timer graceful shutdown + `.unref()`，Promise executor 顶部 `new URL()` try/catch |
| God-file split | HookManager、telemetryQueryService、TaskDAG 按执行引擎 / replay / graph algorithms 拆分 |
| Dead code retirement | POC subsystem、cloud agent module、legacy provider functions、Decorated tools、orphan resume、unused exports 清理；Message 类型统一 |

---

## 2026-04-27 当前新增能力

### Agent Runtime Capability Hardening

| 能力 | 说明 |
|------|------|
| Run lifecycle | `ConversationRuntime` 统一 terminal path，failure/cancel/interrupted 都进入 `RunFinalizer`；cancel 发 `agent_cancelled` |
| Run-level abort | cancel signal 贯穿 ToolExecutionEngine、ToolExecutor、ToolResolver 和长工具执行链 |
| TaskManager-owned chat run | desktop chat send/interrupt 优先走 TaskManager-owned path，减少 session/task 状态漂移 |
| Tool/MCP 权限合同 | `Bash/bash` 归一、`approvedToolCall` 传递、MCP dynamic direct execute、project skill `allowed-tools` trust gate |
| ToolSearch loadable 语义 | 搜索命中但不可调用的项返回 `loadable:false` 和 `notCallableReason`，lazy MCP server 按 query discover |
| Runtime durable state | todos、session tasks、context interventions、compression state、persistent system context、pending approvals kind hydrate 落 SQLite |
| Multiagent reliability | parallel inbox、dependsOn success gate、failed/blocked/cancelled aggregation、run-level cancel |
| Replay / Eval gate | structured replay join model/tool/event evidence；`real-agent-run` gate 绑定 `telemetryCompleteness` |

## 2026-04-26 当前新增能力

### Chat-Native Workbench B+

| 能力 | 说明 |
|------|------|
| ChatInput `+` 菜单 | 附件、slash command、Code/Plan/Ask 收进单一入口 |
| 模型 + effort 胶囊 | 模型和 reasoning effort 作为一组配置展示 |
| Settings “对话”tab | Routing / Browser 低频偏好迁出输入框 |
| Settings 分组导航 | 基础偏好、能力与连接、记忆与隐私、系统四组；搜索和外部跳转复用同一 tab registry |
| Settings 页面骨架 | `SettingsLayout` 统一 settings page / section / details，MCP 诊断信息进入折叠区 |
| Sidebar User Menu | Eval / Lab / Automation / Agent Flow / Desktop 全局入口从 TitleBar 移入用户菜单 |
| Semantic Tool UI | `_meta.shortDescription`、target icon、memory citation、session diff、URL chip 进入聊天渲染 |

### Live Preview V2

| 能力 | 说明 |
|------|------|
| DevServerLauncher | 探测并启动本地 Vite/CRA dev server，显示 logs，关闭 tab 自动 stop |
| Bridge protocol 0.3.0 | `SelectedElementInfo` 回传 `className` 与 `computedStyle` |
| TweakPanel | spacing / color / fontSize / radius / align 5 类 Tailwind 原子修改 |
| Vite-only MVP | Next.js App Router V2-C 已按 ADR-012 延期 |

### Browser / Computer Workbench

| 能力 | 说明 |
|------|------|
| Managed BrowserSession/Profile | sessionId、profileId、profileMode、workspaceScope、artifactDir、lease、proxy |
| AccountState | storageState import/export、cookie/localStorage/sessionStorage summary、expired cookie 分类 |
| TargetRef / Artifact | snapshotId、targetRef、stale recovery、download/upload artifact 摘要 |
| Acceptance suite | System Chrome/CDP、workflow、browser task benchmark、UI、app-host、background AX/CGEvent |
| Computer Surface | foreground fallback、background AX、background CGEvent 三类动作面分开表达 |

### Activity Providers

| 能力 | 说明 |
|------|------|
| ActivityProvider contract | 描述 provider kind、lifecycle、capture source、privacy boundary |
| ActivityContextProvider | 汇总 OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis |
| Prompt formatter | 控制 legacy separate blocks 和 unified activity-context block |

---

## 1. 多模型 SDK 支持

### 支持的模型提供商

| 提供商 | 模型 | 能力 |
|--------|------|------|
| DeepSeek | deepseek-chat, deepseek-coder, deepseek-reasoner | 代码生成、推理 |
| Claude | claude-4-sonnet, claude-3.5-sonnet, claude-3.5-haiku | 通用、代码、视觉、GUI |
| OpenAI | gpt-4o, gpt-4o-mini | 通用、代码、视觉 |
| Groq | llama-3.3-70b, llama-3.1-8b, mixtral-8x7b | 快速推理 |
| Local | qwen2.5-coder (Ollama) | 离线代码生成 |

### 按用途路由

系统会根据任务类型自动选择最佳模型：

```typescript
// 配置位置：Settings -> Models -> Routing
{
  code: { provider: 'deepseek', model: 'deepseek-coder' },
  vision: { provider: 'claude', model: 'claude-3-5-sonnet' },
  fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  gui: { provider: 'claude', model: 'claude-3-5-sonnet' },
}
```

### 配置 API Keys

```bash
# .env 文件
DEEPSEEK_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
GROQ_API_KEY=your-key
```

---

## 2. 云端 Agent (Vercel，历史/已退役)

这段是早期历史能力。近两周主线已删除旧 cloud agent module 和相关 POC 路径；当前产品口径是本地 / Web runtime、Browser / Computer Workbench、Run Status Rail 和 Workspace Preview Review。保留本节只是解释历史来源，不再作为当前安装或部署说明。

### 历史功能

- **浏览器自动化**: 截图、抓取、表单填写、点击
- **云端计算**: 沙箱执行 JavaScript
- **AI 技能**: Web 搜索、代码审查、文档生成、翻译

当前保留的 cloud 相关代码在 `src/main/services/cloud/`，主要是 cloud config、prompt、update、feature flag、orchestrator config 和 cloud proxy 边界，不再是独立 Vercel cloud-agent 产品入口。

---

## 3. GUI Agent (Computer Use)

### 功能

基于 Claude Computer Use API，实现屏幕控制能力：

- 截取屏幕截图
- 鼠标点击/移动
- 键盘输入
- 滚动屏幕

### 启用

```json
// Settings -> GUI Agent
{
  "guiAgent": {
    "enabled": true,
    "displayWidth": 1920,
    "displayHeight": 1080
  }
}
```

### 使用

```typescript
import { initGUIAgent, GUIAgent } from './main/agent/GUIAgent';

const guiAgent = initGUIAgent(
  { displayWidth: 1920, displayHeight: 1080 },
  { provider: 'claude', model: 'claude-3-5-sonnet-20241022', computerUse: true },
  modelRouter
);

// 执行任务
const result = await guiAgent.run(
  '打开 Chrome 浏览器，访问 github.com',
  (action, result) => {
    console.log('Action:', action, 'Result:', result);
  }
);
```

### macOS 权限

GUI Agent 需要以下系统权限：

1. **屏幕录制** - System Settings → Privacy & Security → Screen Recording
2. **辅助功能** - System Settings → Privacy & Security → Accessibility
3. **自动化** - System Settings → Privacy & Security → Automation

---

## 4. macOS 签名打包

### 开发构建（未签名）

```bash
npm run dist:mac
```

### 签名构建

需要 Apple Developer 账号。

```bash
# 设置环境变量
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your-password
export APPLE_ID=your-apple-id
export APPLE_APP_SPECIFIC_PASSWORD=your-app-password
export APPLE_TEAM_ID=your-team-id

# 签名构建
npm run dist:mac:signed
```

### 权限声明

`build/entitlements.mac.plist` 已配置以下权限：

- JIT 执行
- 网络访问
- 文件访问
- 屏幕录制
- Apple Events 自动化

---

## 文件结构

```
src/main/
├── model/
│   └── ModelRouter.ts        # 多模型路由（已更新）
├── services/
│   └── cloud/                # cloud config / update / feature flag（当前保留服务）
├── agent/
│   └── GUIAgent.ts           # GUI Agent（新增）
└── services/core/
    └── databaseService.ts    # 本地 SQLite 服务

build/
├── entitlements.mac.plist           # macOS 权限（新增）
└── entitlements.mac.inherit.plist   # 子进程权限（新增）

scripts/
└── notarize.js               # 公证脚本（新增）
```

---

## 后续计划

1. **完善 GUI Agent 操作实现** - 集成 robotjs 或原生模块
2. **添加 Google AI UI 支持** - 等待 Gemini 2.0 API
3. **API Key 加密存储** - 实现安全存储
4. **交付验收闭环** - Delivery Review / Preview Feedback / artifact verifier 持续补验收场景
