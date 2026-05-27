# Alma 启发的 Neo 改造方案（设计文档）

> 状态：Draft · 待 owner 拍板排期后逐 WS 落地
> 分支：`feat/alma-renovation`（本文档）→ 各 WS 独立分支实现
> 关联：竞品 Alma（yetone，Electron 桌面 AI workbench）逆向 + Neo 现状核对

---

## 0. 背景与方法

**Alma 是什么**：yetone 出品的 macOS 桌面 AI 应用（Electron，`com.yetone.alma`），定位不是 chat 窗口而是「桌面 AI workbench」——统一调度/组合/运行多种 AI 能力。其 subagent prompt 与工具集（`general-purpose`/`Explore`/`Plan` + `Glob/Grep/Read/Edit/Write/Bash/Skill/WebSearch/WebFetch`）与 Claude Code 一致。

**结论：Neo 与 Alma 是「亲兄弟」**——同样复刻 Claude Code 架构，只是投资方向分了岔。本方案不是"补一个落后产品的差距"，而是"在同源底座上，挑 Alma 投得更深、且对 Neo 有真实价值的方向补齐"。

**拆解方法（可复现）**：
1. 解 `Alma.app/Contents/Resources/app.asar`（648MB）：自写零依赖 asar header 解析器，列文件树 + 定点 `extract-file`，避免全量解包。
2. grep 主进程 bundle `out/main/index.js`（1.9MB）拿真实接线：system prompt、热键、AX 捕获 Swift 脚本、本地 server 路由、persona/fatigue、`alma://` 深链规格。
3. 三路并行 Explore agent 核对 Neo 现状（`~/Downloads/ai/code-agent`），每条要 file 级证据 + PRESENT/PARTIAL/ABSENT。

---

## 1. 现状对照（均有代码证据）

### Neo 已有（曾被误判为 gap，已纠正）
| 能力 | Neo 证据 |
|---|---|
| MCP（client + server）| `src/main/mcp/mcpClient.ts`、`mcpServer.ts`（暴露 `code-agent://logs/*` + status）|
| channel bot（Discord/TG/微信/飞书/+Slack）| `src/main/channels/channelAgentBridge.ts`、grammy + Lark SDK |
| cron 定时 | `src/main/cron/cronService.ts`（croner，at/every/cron，动作 shell/tool/agent/webhook/ipc）|
| 本地 STT | whisper-cpp + Qwen3-ASR + Groq 兜底 + VAD（`services/desktop/desktopAudioCapture.ts`）|
| OS 沙箱 | 自研 Seatbelt/Bubblewrap（`src/main/sandbox/`），默认关，仅 bypassPermissions |
| 持久人格 | `src/main/prompts/soulLoader.ts`（SOUL.md/PROFILE.md，安全底线不可被自定义人格绕过）|
| 外部 agent 引擎 | `src/main/services/agentEngine/`（`claudeCodeAdapter.ts`/`codexCliAdapter.ts`/registry + history import）|
| AI SDK | `model/adapters/aiSdkAdapter.ts`，核心 3 provider 已迁（~70%）|
| appshot AX 预算 | `src-tauri/src/appshots.rs`：`AX_TEXT_MAX_CHARS=4000`、深度 40、5000 条 |

### 路线分歧（Neo 主动取舍，**非 gap，不盲目跟**）
- **本地 embedding + sqlite-vec 向量记忆**：Neo 当年删掉 13K 行向量系统改文件版 Light Memory，是有意识决策。Alma 反向保留（sqlite-vec + 可选 4 个本地 embedding 模型）。要不要回头上向量是**独立大决策**，不在本方案范围。

### 真 gap（本方案处理）
1. computer-use 实时 PiP 窗（Alma 有，Neo 无）
2. 深链动作卡片（Alma `alma://`，Neo 无用户向 scheme）
3. 记忆 consolidation 闭环 + session LLM 判断（Alma LLM 压缩去重，Neo 手动 + 仅截断式抽取）
4. 能力 MCP-server 化（Alma 把 computer-use 自注册成 MCP，Neo 的 MCP server 只暴露 logs/status）
5. ACP → **已降级剔除**：Neo `agentEngine` 已覆盖同一意图（手搓 adapter），ACP 仅是"N 个 adapter 换 1 个协议客户端"的实现优化，等生态铺开再说。

---

## 2. 改造范围（5 WS，WS5 拆 5a/5b）

| WS | 内容 | 性质 |
|---|---|---|
| WS1 | AI SDK 收口最后 30%（5 个 legacy provider）| 架构健康度 |
| WS2 | 深链动作卡片 `neo://` | 产品打磨 / demo |
| WS3 | computer-use 实时 PiP 窗 | 产品打磨 / demo |
| WS4 | 记忆 consolidation + session LLM 判断闭环 | 能力补强 |
| WS5a | **只读/安全**能力 MCP-server 化（appshots/screenshot/记忆查询/eval 查询）| 架构（低风险）|
| WS5b | **控屏类危险**能力 MCP-server 化（computer-use）| 架构（高危，门控先行）|

---

## 3. 排期与依赖

排序原则：求职是 owner 第一优先级，**可演示、低风险的先做**。

- **Sprint 1（~1 周）**：WS2 深链卡片 + WS3 PiP 窗 — demo 价值最高，纯增量，复用 appshots overlay 基建。
- **Sprint 2（~1 周）**：WS4 记忆闭环 — 有技术深度可讲。
- **并行后台 track**：WS1 AI SDK 收口 — provider 层隔离，可与 Sprint 1/2 并行，三阶段、评测门控。
- **后置**：WS5a 可排进后续 sprint（拿"能力中枢"叙事）；WS5b 等授权门设计完再做。

**分支策略**：每个 WS 独立分支（off main 或 off 本分支），owner **live 验证后再合**；不主动 push / merge（owner 边界）。

---

## 4. 复用地图（关键：大部分非从零）

| WS | 复用 Neo 现成基建 |
|---|---|
| WS3 PiP | `src-tauri/src/appshots.rs` 的 `animate_overlay_best_effort`（已有透明/穿透/置顶/全屏可见 WebviewWindow + 多屏覆盖）；用 Tauri event 推图，**不必学 Alma 起本地 HTTP** |
| WS4 | `cron/cronService.ts`（后台触发）+ quick model（跑判断/压缩）+ `lightMemory/`（文件读写）|
| WS5 | `mcp/mcpServer.ts` + `mcp/mcp-server-entry.ts`（已有 server 外壳，挂能力即可）|
| WS1 | `evaluation` 评测中心（迁移回归门）|
| WS2 | Tauri 协议处理 + renderer 现有 react-markdown 管线 |

---

## 5. 各 WS 设计

### WS1 — AI SDK 收口 — ✅ Phase 1+2 已实现（分支 `feat/aisdk-finish`），Phase 3 前提被证伪、重定范围
**目标（原）**：消灭"`aiSdkAdapter` + 老 `sseStream` 双推理路"并存的维护税。
**目标（修正）**：把**主 agent loop + 子代理**这条推理路收口到 AI SDK（这才是 path-drift bug 的真实发生地）。"删掉 legacy providers/" 这个更大目标在 WS1 不可行——见下方 Phase 3 纠正。

- **改（已做）**：`model/adapters/aiSdkAdapter.ts`（`AISDK_UNSUPPORTED_PROVIDERS` 清空）、迁移面=`inference.ts:runEngineInference` + `subagentExecutor.ts` 两个调用点（都 gate 在 `aiSdkSupportsProvider`）。
- **三阶段实际落地**：
  - **① 低风险 ✅**（commit `8479276d`）：`gemini → @ai-sdk/google`、`openrouter → @openrouter/ai-sdk-provider`（`resolveModel` switch 加 case）。无 key 没 live，结构验证（路由开关+工厂实例化）过。
  - **② 高风险 ✅**（commit `85bc4ac2`）：`zhipu/moonshot/xiaomi` 走 `@ai-sdk/openai-compatible`，quirk 用 **openai-compatible 官方 settings**（不是 middleware）带过去：`buildVendorCompatSettings()` 的 `includeUsage`/`headers`/`transformRequestBody`（xiaomi `thinking` 字段 + `max_tokens→max_completion_tokens` + top_p；moonshot temp1.0/top_p0.95/UA）+ `inferenceViaAiSdk` 外层套 `getProviderLimiter('zhipu')`。
  - **③ ⚠️ 原文三处假设被代码证伪**：(a) **xiaomi 不是死的**——是 MiMo（artifact text-first 核心写手 + 22 文件引用），必须迁不能删；(b) **并发限流只有 zhipu 一家**（`PROVIDER_CONCURRENCY_LIMITS` 仅声明 zhipu，env 默认 maxConcurrent=3），"Moonshot 最多 2 并发"无代码依据；(c) **reasoning_content 由 openai-compatible 原生映射成 reasoning-delta**（dist 实证），无需自写 middleware；zhipu 三态端点由 `resolveProviderBaseUrl` 处理。
- **验证（已做）**：zhipu 全量 smoke A/B（132 case）**无回归**（aisdk 47.0%/65.7% vs legacy 45.5%/65.2%）；gpt/xiaomi/qwen/moonshot 经 adapter live smoke 工具调用正常（xiaomi 实测 vendor quirk 被真实 mimo SGP 端点接受，qwen 实测 reasoning 映射）；deepseek 此前 E2E 零回归。moonshot/xiaomi 全量 A/B 因 **groq 裁判 fallback 当日 token 配额耗尽**污染评分（与迁移无关），未取干净分。

#### Phase 3「删 legacy 双路」— ❌ 原前提错误，重定为独立 epic
**依赖审计发现**：`model/providers/` 的 17 个 legacy Provider 类**不是只给主 loop 兜底**，而是 `modelRouter` 的后端：`modelRouter.chat()`（被整个 research 子系统 researchExecutor/progressiveLoop/reportGenerator/deepResearchMode 大量调用）→ `this.inference()` → `provider.inference()`（providers Map）→ `sseStream`。此外 `modelRouter` 还提供 `detectRequiredCapabilities/getModelInfo/getFallbackConfig` 给 `inference.ts` 用。**`rm providers/` 会直接断掉 research 子系统和每个 `modelRouter.chat()` 调用方**。`shared.ts`/`providerResolution`/`retryStrategy`/`concurrencyLimiter` 还被 adapter 反向 import。
- **结论**：WS1 收口在 Phase 1+2（主 loop+子代理已迁、验证充分，可合并）。真正"消灭 legacy 双路"= 把 `modelRouter.chat` + 全部 research 消费方 + quickModel 都迁到 AI SDK，是远超 WS1 的独立 epic，**单列后续**。
- 只删主 loop 的 `CODE_AGENT_MODEL_ENGINE` 闸门也不划算（legacy 代码因 chat 仍在，等于丢主 loop 回退网却没减代码量）→ 暂保留闸门作回退网。

### WS2 — 导航深链卡片（扩展现有 IACT）— ✅ 已实现，待 E2E
**⚠️ 现状修正（Explore 核出）**：Neo **已有** IACT 协议——`MessageContent.tsx` 的 `components.a` 已处理 `[文字](!send/!add/!run/!open/!preview/!copy/!ticket)`，`prompts/identity.ts` 的 `<inline_actions>` 已教模型产出，`ChatInput/index.tsx` 监听 `iact:add` 做预填。**所以 WS2 不是从零造深链**，缩小为"补 IACT 缺的**导航类**动作"，且 **in-chat 卡片纯 renderer + prompt，不需要 Tauri deep-link 插件**。

**已做**：
- `MessageContent.tsx`：`components.a` 加 `neo://` 分支 → `IACTNavCard`（复用 `IACTCopyButton` 范式），点击调 `useSessionStore.switchSession/createSession`、`useAppStore.openSettingsTab`；settings tab 走 `SETTINGS_TAB_IDS` 白名单校验；非法链接退化纯文本不破卡。
- `identity.ts` `<inline_actions>`：补 `neo://thread/<id>`、`neo://thread/new`、`neo://settings/<tab>` 语法 + 一个导航 example（`builder.ts` 已串入，无需改装配）。
- `compose 预填` 已被现有 `!add` 覆盖，未重复造。
- **不做（本轮）**：OS 级 `neo://` 外部唤起（需 `tauri-plugin-deep-link`，与 in-chat 卡片无关，单列可选增强）。

**验证**：tsc + E2E 渲染含 `neo://` 的消息、点击确认切会话/新建/跳设置。

### WS3 — computer-use 实时 PiP 窗
**目标**：自主操作（computer-use）进行时，给一个不打扰的实时活动小窗，提升信任/透明度。

- **改**：src-tauri 复用 appshots overlay 模式起一个常驻小窗（参考 Alma：320×220 右上、透明穿透置顶、全屏空间可见）；computer-use 每步截图经 **Tauri event** 推到 PiP（比 Alma 轮询本地 HTTP 更简洁）；会话起隐、自主操作时显、结束关。
- **复用**：appshots Phase 3.1 已解的多屏/全屏覆盖（objc2 抬 NSWindow level）直接抄。
- **风险**：窗口生命周期与会话切换串台（参 appshots 的 startingSessionId 绑定教训）。
- **验证**：跑一次 computer-use 任务，肉眼 + 截图确认 PiP 实时刷新、操作完自动关。

### WS4 — 记忆 consolidation + session LLM 判断闭环
**目标**：让记忆"会自己整理/判断"，守住 Light Memory 文件哲学，**不引入向量库**。

- **A（session 判断）**：把 `agent/runtime/runFinalizer.ts` 的 `extractAndSaveConversationSummary`（现为"截前 50 字当标题"）升级为 quick model 跑 `worth / isMeeting / title / worthKnowledge` 判断，只存值得留的；异步执行不阻塞收尾。
- **B（consolidation）**：cron 周期任务读 `lightMemory/` 文件 → LLM "compress WITHOUT losing information"（对标 Alma：DELETE 冗余 + 合并）→ 自动维持 INDEX.md 在预算内，替掉现在手动的 "Please consolidate"。
- **风险**：LLM 压缩丢信息 + token 成本。
- **验证**：**dry-run 模式**（先输出 diff 不落盘）+ 抽查压缩前后信息无损；成本用 quick model 控。

### WS5 — 能力 MCP-server 化
**目标**：让 Neo 独家能力被其他 agent（Claude Code/Codex 等）反向调用，使 Neo 成为多 CLI 工作流的「能力中枢」。

- **5a（先做，低风险）**：扩 `mcp/mcpServer.ts`，把**只读/安全能力**schema 化暴露——appshots、screenshot、记忆查询、eval 查询。立刻拿到"能力中枢"叙事价值。
- **5b（后置，门控先行）**：暴露 computer-use 等**控屏类危险能力**。前置必做：授权门设计（MCP client 调 computer-use = 能控屏，必须 permission gate + 审计）。**先出安全设计文档再开工。**
- **参考**：Alma 把 computer-use 做成 `bin/alma-computer-use-mcp.mjs` 自注册进 `~/.config/alma/mcp.json`（`ELECTRON_RUN_AS_NODE`，幂等校验）。

---

## 6. 验证哲学
- owner 不读代码，**review = E2E 实证**：每个 WS 交付必须有可演示的行为证据（截图 / 跑通的任务 / 评测分数），不交 code-review 清单。
- WS1 用评测中心做回归门；WS2/WS3 用浏览器/桌面 E2E；WS4 用 dry-run diff；WS5 用 MCP client 实调 + 权限拒绝用例。

## 7. 待拍板 / Open Questions
- [ ] 排序确认：Sprint 1 = WS2 + WS3（demo 优先），还是 WS1 提前（健康度优先）？
- [ ] WS5a 这轮是否排入，还是先搁置等前四条落地？
- [ ] WS4 consolidation 用哪个 quick model（成本 vs 质量）？
- [ ] `neo://` scheme 名最终定 `neo://` 还是 `code-agent://`（后者已被 MCP 内部 resource URI 占用，需区分）。

---

## 附录：Alma 关键实现参考（从 app.asar 扒到，供实现时对照）
- **能力即 MCP**：computer-use 自注册 MCP server（`~/.config/alma/mcp.json`）；外部 ACP agent 经 `@mcpc-tech/acp-ai-provider` 包装成 AI SDK provider。
- **本地控制面**：Express server（端口 23001），provider REST CRUD + `/mcp/oauth/callback` + 启动用户真实 Chrome 注入扩展。
- **PiP**：透明 320×220 右上窗，轮询 `localhost:23001/api/computer-use/pip/latest`（读 `/tmp/alma-cu-state-*.jpg`）。
- **AX 捕获**：内嵌 Swift（`AXUIElementCopyAttributeValue`），预算 `TEXT_BUDGET=8000 / MAX_DEPTH=30 / MAX_CHILDREN_PER_NODE=80`；浏览器侧用 CDP `Accessibility.getFullAXTree` → 紧凑文本（`ref role "name" [flags]`）。
- **`alma://` 深链段**（system prompt 原意）：thread/compose(`?text=` 预填不发)/settings(`<section>`: general,providers,agents,channels,workspace,chat,prompts,memory,mcp,skills)；附"别滥用"约束。
- **记忆**：sqlite-vec + 可选本地 embedding（MiniLM-L6 / BGE-small / multilingual-e5 / paraphrase-multilingual）+ LLM consolidation agent。
- **persona/fatigue**：assistant 有"疲劳/blended state"，每条消息 `recordMessage()`，`getFatigueStatus().prompt` 注入 system prompt。
- **依赖底牌**：`@anthropic-ai/sandbox-runtime`、`node-pty`、`playwright`、`@fugood/whisper.node`、`@ai-sdk/*` v6、`@ai-sdk-tool/parser`、`acpx`、`@larksuiteoapi`、`discord.js`、`weixin-agent-sdk`、`croner`、`electron-liquid-glass`、`framer-motion`、`@lobehub/ui`。
