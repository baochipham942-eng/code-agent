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

### WS1 — AI SDK 收口
**目标**：消灭"`aiSdkAdapter` + 老 `sseStream` 双推理路"并存的维护税（历史上多次 path-drift bug 的根源）。

- **改**：`model/adapters/aiSdkAdapter.ts`（`AISDK_UNSUPPORTED_PROVIDERS` 集合）、`agent/runtime/contextAssembly/inference.ts`（fallback 路由）；全迁完删 `model/providers/` 老 sseStream。
- **三阶段**：
  - ① 低风险：`gemini → @ai-sdk/google`、`openrouter → @openrouter/ai-sdk-provider`（官方 provider，Alma 已在用）。
  - ② 高风险：`zhipu`/`moonshot` 走 `@ai-sdk/openai-compatible`，**关键 quirk 以 middleware 形式带过去**——智谱并发 4 限流 + stream_options + reasoning_content 回退；Moonshot 最多 2 并发 + 无 stream_options + thinking 模式。
  - ③ `xiaomi` 先确认是否仍在用，死了直接删；全迁完删双路。
- **风险**：丢智谱/Moonshot 用血换来的限流和 reasoning 兜底。
- **验证**：每阶段跑评测中心，GLM/Kimi 路径分数不回归。

### WS2 — 深链动作卡片 `neo://`
**目标**：把 AI 的"建议"从一段话变成一次点击（在 app 内执行，不开浏览器）。

- **改**：`tauri.conf.json` 注册 `neo://` scheme + src-tauri 协议处理；renderer react-markdown 拦截 `neo://` 链接渲染成卡片按钮，点击经 IPC/router 执行；`src/main/prompts/` 加 DEEP LINKS 段教模型产出 + "genuinely shortens next step 才用，别滥用"约束。
- **路由**（对标 Alma）：`neo://thread/<id>`(+`/message/<id>`)、`thread/new`、`compose?text=`（预填**不发送**）、`compose?thread=<id>&text=`、`settings/<section>`。
- **风险**：模型滥撒卡片（prompt 约束 + 渲染层兜底/限频）。
- **验证**：E2E 点击各类卡片确认跳转/预填正确、`compose` 不自动发送。

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
