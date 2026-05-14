# Agent Loop & 工具系统 Gap 分析（阶段 2 靶子文档）

> 日期：2026-05-14
> 范围：agent loop + tool dispatch + context/compaction + sub-agent 编排（中等范围）
> 用途：本文档是「多模探讨」阶段的**靶子**——结论尚未收敛，每条 Gap 都欢迎被推翻、补充或重新归因。
> 素材来源：
> - 内轨现状：`code-explorer` subagent 深挖 + `code-agent` CLI 自举分析（交叉印证）
> - 外轨竞品：Gemini（Claude Code + Cline）、MiniMax（横切最佳实践）、Codex CLI（自身设计，从其源码探索过程捞取）
> - 注意：本文部分 god-file 条目可能与 `docs/analysis/god-file-split-roadmap.md` 重叠，阶段 3 需交叉核对去重。

---

## 一、现状架构速写（四块）

### A. Agent Loop 核心
- 入口 `AgentOrchestrator.sendMessage()` → `ConversationRuntime.run()`（`runtime/conversationRuntime.ts:536`）。
- 主 while 循环条件：`!isCancelled && !isInterrupted && !circuitBreaker.isTripped() && iterations < maxIterations`（`conversationRuntime.ts:550`）。
- 每轮：`waitWhilePaused` → 预算检查 → `streamHandler.setupIteration` → 注入 plan/memory → `contextAssembly.inference()`（唯一推理点）→ `decideNextAction()`（仅 advisory）→ `detectAndForceExecuteTextToolCall` → 分流 `handleTextResponse` / `handleToolResponse`。
- `ConversationRuntime` 持有 4 个协作模块（`ToolExecutionEngine` / `ContextAssembly` / `RunFinalizer` / `LearningPipeline`），经 `setModules()` 延迟互注入，全部共享同一个 `RuntimeContext`。

### B. 工具 Dispatch + 权限
- 双轨注册：`protocolRegistry`（运行时绑定）+ `tools/dispatch/toolDefinitions.ts`（业务门面，cloud > dynamic > static 优先级）。
- 主 agent 路径：`handleToolResponse` → `ToolExecutionEngine.executeToolsWithHooks` → `executeSingleTool` → `ToolExecutor.execute()`（完整权限管道：requiredFields 校验 → 文件 checkpoint → `validateCommand` → exec policy → `isKnownSafeCommand` → `classifyPermission` 三路 → 用户审批 → handler 执行）。
- subagent 路径：`ProtocolToolResolver.execute()`——注释明确「本入口不过 ToolExecutor 的权限闸门」（`toolResolver.ts:39`）。
- 并行：`classifyToolCalls` 分 parallel-safe / sequential，`executeInBatches` 按 `MAX_PARALLEL_TOOLS` 批量 `Promise.all`。

### C. Context / Compaction
- `CompressionPipeline.evaluate()` 六层：L1 tool-result-budget（始终）→ L2 snip（≥50%）→ L3 microcompact（≥60%）→ L4 contextCollapse AI 摘要（≥75%）→ L5 autocompact-needed（≥85%，**仅标记不执行**）→ L6 overflowRecovery（API overflow 时）。
- `CompressionState` 是 append-only commit log + snapshot，原始 transcript 不可变，`ProjectionEngine` 投影出 API view。
- `AutoContextCompressor` 是**另一条独立路径**（truncate / code_extract / ai_summary），与 Pipeline 并存。
- compaction 后 `SurvivorManifest` 提取保留清单（文件路径 / 命令 / 错误 / TODO / artifact），`enforceManifestBudget` 靠 pop 末尾条目控预算。

### D. Sub-agent 编排
- `SubagentPipeline` 管生命周期，`SubagentExecutionContext` 持权限/预算/allowedTools/AbortController。
- `SubagentContextBuilder` 三级注入：minimal（~500 tok）/ relevant（~1500 tok）/ full（~3000 tok）；层级选择是文档注释，调用方自行决定。
- 持久化走 `SubagentContextStore`（sessionId+agentId 为 key，JSON 落盘 TTL 2h）。
- 长跑 subagent 走轻量 `compactSubagentMessages()`，不走父 agent 的 CompressionPipeline。
- 结果经普通 `tool_result` 路径回灌父 agent，无专用聚合协议；`resultAggregator.ts` 存在但未见主循环集成点。

---

## 二、竞品最佳实践对照

| 维度 | Claude Code | Cline | Codex CLI | MiniMax 综合推荐 |
|------|-------------|-------|-----------|------------------|
| Loop | 高并发工具调用 + 主观/客观双终止 | ReAct 与前端 UI 强绑定，XML 流式解析 | rollout-trace 结构化追踪 tool_dispatch/compaction/inference；`debug prompt-input` 可见模型实际输入 | 四层循环（Session/Plan/Action/Recovery），决策与执行解耦 |
| Tool | 原生 function calling，并行优先 | Plan/Act 双模 + 写操作强制人类 Approval | 统一 `ToolExecutor` trait + `ToolHandler.matches_kind` 类型化；平台级 sandbox（Seatbelt/bubblewrap/restricted token）| Schema 骨架 + 可选 Lifecycle + 内置 Permission + 工具链一等公民 |
| Context | 分层衰减：micro-compaction → 外部 MEMORY → 语义全量压缩重开窗口 | 现场重建：抓 IDE diagnostics/terminal/选区；AST 签名折叠 | rollout-trace 有独立 compaction 追踪 | 近期 full / 中期 LLM 摘要 / 早期高压缩 + 索引；保留原始引用可追溯 |
| Sub-agent | 派生隔离 Explorer，独立上下文窗口，回结构化报告 | 角色化串行（Architect→Coder），非并发隔离 | `agent_control` 服务：`send_input` / `interrupt_agent` / `get_status` 结构化 agent 间通信 | Orchestrator 模式，任务粒度自适应，资源预算 + 失败隔离 |

---

## 三、Gap 清单（问题 + 证据 + 竞品对照 + 影响 + 待验证假设）

> 标注 `[假设]` 的方向是初步判断，**待阶段 3 多模批判**。

### A. Agent Loop

**G1 — loopDecision 死区：决策算了不执行**
- 证据：`decideNextAction()` 返回的 `LoopDecision` 在 `conversationRuntime.ts:648-669` 只被 `logger.info` 打印，无 if/switch 真正消费；`budgetRemaining` 硬编码为 `1.0`（`:659`，注释 `TODO: wire to budgetService`）。terminate/compact/fallback 的实际执行体散在 `messageProcessor.ts` 和压缩路径里各自独立实现。
- 竞品：理想 loop 要求决策与执行解耦但**连线必须接通**（MiniMax）；Codex 用 rollout-trace 把 decision 结构化记录。
- 影响：预算保护永不触发；决策引擎结论与实际行为漂移，`loopDecision.ts` 沦为装饰。
- [假设] 要么接通 seam（让 runtime 真正消费 decision），要么删掉这个引擎别留假抽象。

**G2 — 迭代计数语义混淆**
- 证据：`iterations++` 无重置机制，compaction / reinference 都不重置；`maxIterations` 同时承担「思考步数上限」和「恢复重试上限」两个语义。
- 竞品：Claude Code 主观终止（模型自判完成）+ 客观终止（步数/token/连续错误）分离。
- 影响：一次 compaction 后续的正常迭代被算进同一额度，复杂任务可能被过早 terminate。
- [假设] 拆分「推理步数」与「恢复动作」两个计数器。

**G3 — initializeRun 过度膨胀（~350 行）**
- 证据：串行塞入 desktop context / session recovery / seed memory / activity context / hook manager / task complexity / parallel judgment / intent classification / dynamic mode / skill invocation，耦合度低却堆在一个方法里。
- 竞品：MiniMax 推荐 pipeline 阶段化。
- 影响：turn 启动延迟不可拆分归因；新增编排步骤只能继续往里堆。
- [假设] 改造成可插拔的 init pipeline 阶段。

**G4 — 三大运行时文件隐式循环依赖**
- 证据：`ConversationRuntime ↔ ToolExecutionEngine ↔ MessageProcessor` 经 `setModules()` 互相注入；三文件 import 头高度重叠（机械切分痕迹，公共依赖未提升）。
- 影响：违反依赖倒置，单测难以隔离，状态流转跨文件难追踪。

### B. 工具 Dispatch + 权限

**G5 — 双路径 dispatch 不对称（安全风险）**
- 证据：主 agent 走 `ToolExecutor.execute()` 全权限管道；subagent 走 `ProtocolToolResolver.execute()` 显式绕过权限闸门 / 审计 / cache（`toolResolver.ts:39`）。
- 竞品：Codex 统一 `ToolExecutor` trait，所有工具调用同一入口。
- 影响：subagent 可执行未经权限分类与审批的工具，权限模型存在绕过口子。
- [假设] 统一 dispatch 入口，subagent 的差异化用配置（allowedTools / 预算）表达而非走旁路。

**G6 — DenyRules 进程级可变全局**
- 证据：`denyRules` 是模块级数组（`denyRules.ts:25`），`addDenyRule/clearDenyRules` 无锁。
- 影响：多 agent 并发场景竞态，一个 agent 的 deny 规则污染另一个。

**G7 — parallel + DAG 两套并行机制无统一调度**
- 证据：`parallelStrategy.ts`（分类 + batch）与 `dagScheduler.ts`（文件读写依赖 DAG 拓扑排序）独立存在，DAG 排序结果未见被主循环消费的代码路径。
- 影响：要么 DAG 是死代码，要么并行正确性靠 parallelStrategy 的静态集合兜底，依赖感知调度未真正生效。
- [假设] 确认 dagScheduler 是否激活；未激活则要么接入要么删除。

**G8 — executeSingleTool 拦截逻辑重复**
- 证据：artifact repair guard / repeated patch guard / parse error / schema validation / read-only preflight / force final 等每种拦截各自独立构造 `ToolResult` + emit event + telemetry；artifact repair 的 guard 检查散布 6+ 处（`enforceArtifactRepairGuard` 等），各自递增 `blockedToolCount`。
- 竞品：中间件 / decorator 链模式（MiniMax）。
- 影响：代码高度重复；多处独立计数器易状态不一致。
- [假设] 抽统一的拦截链（middleware chain），拦截器只返回 decision，结果构造与 telemetry 统一。

**G9 — toolExecutionEngine.ts 3169 行 god-file**
- 证据：约 60% 是 artifact repair guard 辅助函数（contract parsing / read window detection / patch fingerprinting / rollback snapshot），尽管已部分抽到 `artifactRepairSpec.ts` / `artifactRepairGuard.ts`，残留依然巨大。
- 注：可能与 `god-file-split-roadmap.md` 重叠，需去重。

**G10 — 缺失 OS 级沙箱**
- 证据：code-agent 权限模型靠 `classifyPermission` + 用户审批，无 OS 级隔离执行。
- 竞品：Codex 有平台级 sandbox（macOS Seatbelt / Linux bubblewrap / Windows restricted token）。
- 影响：审批通过的命令仍以宿主权限运行，破坏性操作无第二道防线。
- [假设] 是否引入 OS 沙箱取决于产品定位（桌面应用 vs CLI），需阶段 3 判断 ROI。

### C. Context / Compaction

**G11 — 两套压缩体系并存职责不清**
- 证据：`CompressionPipeline`（结构化六层）与 `AutoContextCompressor`（策略式截断）并列，调用点分散。
- 影响：可能重复压缩；同一压力下两条路径行为不一致。
- [假设] 合并为单一压缩入口，AutoContextCompressor 的策略并入 Pipeline 的某层。

**G12 — L5 autocompact-needed 是空报告**
- 证据：Pipeline 在 ≥85% 时只 `layersTriggered.push('autocompact-needed')`，不执行实际 compaction；真正的 compaction 由 loop 另一路径（`checkAndAutoCompress`）触发。
- 影响：两条路径协调靠 `layersTriggered` 数组的 consumer 自觉判断，是隐式约定而非显式契约。

**G13 — L4 summarize 可选且静默跳过**
- 证据：`summarize` 在 `PipelineConfig` 里是可选字段（`compressionPipeline.ts:31`），未注入时 L4 contextCollapse 静默跳过、不报错。
- 影响：高压力下 AI 摘要可能悄无声息地没发生，难以发现。

**G14 — SurvivorManifest 破坏性截断无智能保留**
- 证据：`enforceManifestBudget` 通过 pop 末尾条目控预算（`survivorManifest.ts:631`），优先级是固定顺序（commands→errors→todos→openWork→artifacts→filePaths→dataFingerprint）。
- 影响：超预算时末尾条目（filePaths/dataFingerprint）被无差别丢弃，无相关性感知。

### D. Sub-agent

**G15 — subagent context 预算过小且无自动升降级**
- 证据：full 模式才 ~3000 tokens；层级选择逻辑只是文档注释，调用方自行决定，无自动升降级机制。
- 竞品：MiniMax 推荐资源预算自适应；Claude Code 的 Explorer 用独立完整上下文窗口。
- 影响：复杂 subagent 任务极易丢关键状态。

**G16 — subagentExecutor.ts 54K god-class**
- 证据：文件大小本身是 god-class 信号（未全量读取）。

**G17 — 结果聚合无专用协议**
- 证据：subagent 结果走普通 `tool_result` 路径回灌，`resultAggregator.ts` 存在但未见主循环集成点。
- 竞品：Codex `agent_control` 有 `send_input` / `interrupt_agent` / `get_status` 结构化通信。
- 影响：父 agent 无法区分「普通工具结果」与「子 agent 报告」，也无法中断/查询运行中的 subagent。

**G18 — subagent 权限继承未强制校验**
- 证据：`parentPermissionConfig` 字段存在但检查是 subagent pipeline「自愿」的，无强制下钻校验。
- 影响：subagent 理论上可申请超出父 agent 的权限。

### 横切

**G19 — RuntimeContext god-object（~150 字段）**
- 证据：覆盖配置 / 服务引用 / run 状态 / plan mode / hooks / 工具执行 / 结构化输出 / 步进 / tracing / research mode / budget / stagnation / artifact repair / turn tracking 等完全不同关注点；所有模块共享同一引用直接读写。它既是 DI 容器又是全局可变状态袋。
- 影响：状态流转不可追踪，任何模块可随时改任何字段，并发与测试都困难。
- [假设] 拆分为 `不可变配置` / `服务注册表` / `每-run 可变状态` 三类，可变状态再按子域收敛。

**G20 — 可观测性缺结构化追踪**
- 证据：有 telemetry，但 loop decision 只 log；无统一的「一个 turn 内 决策→执行→观察」结构化 trace。
- 竞品：Codex 有 `rollout-trace` 独立子系统（tool_dispatch / compaction / inference 分别追踪）+ `debug prompt-input` 可看模型实际输入。
- 影响：排查「为什么 loop 这么走」要靠翻散落的 log。

---

## 四、留给阶段 3 多模探讨的开放问题

1. **优先级**：G1（死区）、G5（权限绕过）、G19（god-object）哪个是真正的「核心流程」病灶？哪些是噪音？
2. **归因**：G4 / G9 / G16 的巨型文件和循环依赖，是「架构债」还是「机械切分未完成」的中间态？该不该现在动？
3. **竞品取舍**：G10（OS 沙箱）、G17（agent 通信协议）这类竞品有而 code-agent 没有的，是该补还是产品定位本就不需要？
4. **伪 Gap 排雷**：哪些 Gap 其实是 code-explorer / 自举分析读漏了上下文造成的误判？（尤其 G7 dagScheduler 是否真死代码、G12 两条 compaction 路径是否真未协调）
5. **改造 ROI**：如果只能动 3 件事，动哪 3 件，预期撬动什么指标（eval 分 / token 成本 / 稳定性）？

---

## 五、阶段 3 多模探讨：三家立场

三个独立模型（Gemini / MiniMax / Codex）各自批判本文档前四节，关键结论：

### 三家共识（3/3 一致）
- **G5 权限绕过** —— 真实安全缺口，优先级最高，严重性可能被**低估**。Codex 主张与 G18 合并处理（统一工具入口 + 强制权限下钻）。
- **G19 RuntimeContext god-object** —— 真实根因，进 Top 3，但**三家都反对大爆炸式拆分**。共识最小修法：冻结访问面（配置 / 服务 / run-state 三类分离 + 只读标记），新增字段强制进子域。
- **G7 DAG 双机制** —— 高概率伪 Gap，大概率是分析者没追到调用链。需运行时 trace 证明 DAG 真没被消费，才能定性。
- **G3 / G9 / G16 体积类问题** —— 严重性被**高估**。行数大 ≠ 架构错误；G9/G16 与 `god-file-split-roadmap.md` 重叠，不该自动升格为核心病灶。
- **G4 循环依赖** —— 2/3（MiniMax / Codex）判为机械切分未完成的中间态，现在大拆 ROI 低。共识：给依赖边界上护栏（提公共 contracts / events / state accessors，禁止双向注入继续扩大），不主动拆。

### 关键分歧：G1 决策死区
- **Gemini**：致命，必须立刻接通 `switch(decision)`。
- **MiniMax**：优先级最低，建议直接删掉假抽象的消费代码。
- **Codex**：取决于产品是否已承诺使用 —— 若只是实验性 planner 就是废抽象。
- **裁定**：分歧本身指向 G20 —— 在没有结构化 trace 之前，无法判断 G1 是「核心缺口」还是「废抽象」。**正确的第一步不是接通也不是删除，而是先把 `LoopDecision` 变成 trace 一等事件**（并入 G20），用数据说话，再决定接通 terminate/compact 还是删除。

### G20 结构化追踪 —— 被低估的杠杆
MiniMax 和 Codex 都把 G20 提进 Top 3，理由一致：**没有 trace，关于 G1/G7/G11/G12 的争论全是静态读代码猜**。G20 是其他诊断的前置条件。

---

## 六、收敛结论：优先级裁定

综合三家，**如果只动 3 件事**：

| 优先级 | 行动项 | 为什么 | 最小修法 | 风险 |
|--------|--------|--------|----------|------|
| **P0** | G5 + G18：统一工具入口 + 强制权限下钻 | 唯一的真实安全缺口，三家一致，绕不过去 | 所有 dispatch 入口（含 subagent）必须进同一 `ToolExecutor`，subagent 只带不同 `ExecutionPolicy/PermissionScope`；创建 subagent 时算 effective permissions，执行时再校验不可越权 | 低，改的是入口收口 |
| **P1** | G20：落 turn 级结构化 trace | 其他诊断的前置条件；能反过来验证 G1/G7/G11/G12 是真 Gap 还是误判 | 主循环关键节点 emit `TraceEvent{ prompt/context hash, decision, tool dispatch, permission, compaction, result }` | 低，只加不改 |
| **P2** | G11/G12/G13：压缩入口契约化 | Context 是 loop 的燃料，两套压缩路径分裂会让同一任务在不同压力下行为漂移，影响稳定性比 god-file 直接 | 设单一 `ContextPressureController`，两套实现先当 strategy 不急合并；定义 `CompressionDecision{recommend/execute/defer}`；L4 缺 summarizer 时 emit warning + 降级到确定性策略 | 中，需先补集成测试（见 G22） |

**明确排除出 Top 3**：G1（先 trace 化再说）、G19（长期根因但短期只上护栏不拆）、G9/G16（并入既有 god-file roadmap）、G2（拆三计数器即可，非根病）。

---

## 七、补充 Gap（多模发现的文档遗漏）

阶段 3 三家独立补出的、原靶子文档漏掉的问题：

- **G21 取消/暂停/恢复的一致性**（MiniMax + Codex 双发）—— `isCancelled/isInterrupted` flag 在流式场景下，父子 agent / 工具执行 / compaction / finalizer 在取消时是否一致收敛？桌面 agent 里这容易变成幽灵任务和状态错写。**优先级：高，建议补入 P 序列。**
- **G22 Compaction 缺端到端测试覆盖**（MiniMax）—— 六层压缩 + SurvivorManifest 的组合行为高度不确定。本文档所有「压缩路径是否协调」的讨论都建立在「它能工作」的假设上。**这是 P2 的前置依赖。**
- **G23 模型实际输入不可回放**（Codex）—— 能否回放每轮 prompt / tool schema / 压缩后上下文？否则 eval 失败无法复现。与 G20 强相关。
- **G24 工具结果副作用未建模**（Codex + Gemini）—— 工具结果是否可缓存 / 是否改文件系统 / 是否污染上下文，缺统一描述；且 L1 budget 只粗暴截断，缺语义错误特征提取，导致模型看不到关键报错行陷入 stagnation。
- **G25 MCP 生态支持**（MiniMax 提出，2026-05-14 已评估）—— 评估结论如下：
  - **Client 能力扎实，甚至超出 Claude Code**：4 种 transport（stdio / SSE / HTTP Streamable / 自创的 in-process）、懒加载、并发批控、基于 MCP annotation 的权限自动映射、deny 通配规则、工具定义 LRU 缓存、输出 50K 截断保护。
  - **Server 能力定位不同**：`dist/mcp-server.js` 仅 stdio transport（CLI 声明了 `--transport http` 但构造函数忽略 options，**HTTP 模式未实现**）；暴露的是自我观测/远程控制工具（get_logs / status / computer / screenshot），不暴露核心编码能力。
  - **两条高优先级硬伤**：① **无 `listChanged` 通知处理** —— 长会话里 MCP server 动态增删工具不感知，会"工具在却调不到"或调用已失效工具，直接影响 agent loop 可靠性；② **无 `.mcp.json` 配置文件 + scope 分层（local/project/user）** —— MCP 配置无法随项目走、无法团队共享、无法纳入版本控制，对标 Claude Code 工作流最明显的体验落差。
  - **疑似死代码**：OAuth 有完整实现（`oauth.ts`）但 `createTransport` 未调用 `getAuthHeaders`，OAuth headers 注入路径存疑，需复查；且缺 PKCE / DCR / 401 自动发现。
  - **建议**：补 `listChanged` 和 `.mcp.json`+scope 两条（高）；复查 OAuth 接线（中）；HTTP server transport、Resource subscribe、Sampling、Roots 优先级低。
- **G26 computer-use 自操作被一刀切拦死**（E2E 验证时发现）—— MCP 的 Computer Surface 把整个 Code Agent app 标为 protected，`open_application` / `get_ax_elements` 等自动化全部拦死。影响：agent 无法操作自己的设置页 / 会话管理 / 读自身 UI 状态，而这些本是合理且更智能的自操作能力（类比 Claude Code 能改自己的 config）。真正该拦的只有 **reentrancy** —— agent loop 通过 computer-use 驱动正在驱动它自己的输入/run 入口，形成递归咬尾。[假设] 把保护收窄：区分「为用户任务自动化自己 UI」（放行）vs「agent 自动化自己的活动 loop」（拦），需 loop 重入检测 + 深度上限。

---

## 八、下一步

本文档已完成「现状梳理 → 竞品对照 → Gap 清单 → 多模收敛」全链路。建议：
1. **P0（G5+G18）可直接立卡开工** —— 安全缺口，无需进一步论证。
2. **P1（G20）和 G22（compaction 测试）先行** —— 它们是 P2 及后续所有诊断的地基。
3. **G1 的去留、G7 是否死代码，等 G20 trace 落地后用数据裁定**，不要现在拍脑袋。
4. **G21（取消一致性）建议补一次专项排查**，它在桌面 agent 里是隐藏的生死线。

> 方法论备注：本次探讨用了 5 路并行作业（内轨 code-explorer + code-agent CLI 自举；外轨 Gemini/Codex/MiniMax），阶段 3 由 3 个独立模型交叉批判。code-agent CLI 自举分析独立印证了 code-explorer 的核心发现，是一个正向产品信号。
