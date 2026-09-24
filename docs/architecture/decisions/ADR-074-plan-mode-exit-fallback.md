# ADR-074：Plan 模式正文收尾但未调用退出工具的兜底

- 状态：**提议，等待产品负责人拍板**
- 单号：N-PLAN-SYNTHEXIT（本页只定行为，不施工）
- 基线：`origin/main@158bb32492f3d5930e2effa9bfefe6b0c3765769`
- 证据：`code-agent-private-archive/docs/evidence/N-PLAN-SYNTHEXIT-2026-09-24.md`
- 相关：`N-ENGINE-PERMMODE-MAP`（外部引擎 `plan → read-only`；bypass 对外部引擎只映射为 `acceptEdits`，写回仍回 Neo 审批），`src/host/tools/modules/planning/exitPlanMode.ts`。

## 问题与现状

Plan 模式 reminder 要求模型探索、澄清、生成计划，最后调用 `PlanMode({ action: "exit", plan })`；它没有宿主层的缺工具兜底。模型若只返回计划正文，`conversationRuntime` 会按普通 text 响应交给 `messageProcessor.handleTextResponse`；该路径持久化 assistant 文本、发 `turn_end` 并结束本轮，`flowState.isPlanModeActive` 不变。只有真正收到 `exit_plan_mode`/`PlanMode(action=exit)` 工具结果时，`shouldEndRunForPlanApproval` 才标记等待审批并结束 run。结果是用户看见计划文字，却没有可点的审批卡，会话还留在 plan mode。

当前只读约束仍有效：plan mode 的工具面与 `enter/exit` schema 控制写权限，审批边界收到退出工具后会在下一次推理前结束 run。任何兜底都不能让写类工具在审批前获得一次执行机会。

**真实运行**：本轮没有找到可复用的无 UI `/plan` chatprobe 驱动；仓内现有 real-run/eval 入口只跑通用评测，不能稳定注入同一小任务并判定是否出现退出工具。没有用历史普通 trace 冒充该证据，记为 `NOT_RUN`；实现票的真实门保留一轮非 Claude + 一轮 Sonnet、各自记录 run id 与费用，合计上限 USD 1。

## 方案对照（公开事实；“未说明”处为推断）

| 系统 | 公开行为 | 对本问题的可借鉴点 |
|---|---|---|
| Claude Code | CLI 有 `--permission-mode plan`，用于以计划权限启动会话（官方 CLI reference）。公开页面没有承诺“正文结束未调用退出工具”时由宿主合成审批卡；后半句是基于公开文档的未说明项。 | 计划是权限/会话模式，退出审批仍应是宿主边界；不能把普通文本当已批准。 |
| Codex | OpenAI 文档把 `/plan` 定义为先提出实现路径、等待用户审阅，再进入执行；公开资料没有要求模型必须调用某个退出工具，也没有公开漏调用时的兼容契约。 | 宿主应该把“计划已形成、等待审阅”当一等状态，而不是把正文当执行许可。 |
| Hermes / OpenClaw | Hermes 的危险动作在执行前进入 approval mode；OpenClaw 将 host exec、插件请求和 ACP 权限分层，工具执行前才进入审批。两者公开文档都未定义 plan 文本自动变审批卡。 | 审批必须在动作前；plan 兜底只能生成审批状态，不能放宽动作闸。 |

参考：Anthropic [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)、OpenAI [Codex remote engineering](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)、Hermes [security/approval](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/security.md)、OpenClaw [permission modes](https://github.com/openclaw/openclaw/blob/main/docs/tools/permission-modes.md)。

## 决策提议：方案 (a) 的“提醒一次，失败后合成卡”

选方案 **(a) nudge**，并把一次有界合成作为同一方案的第二步：先给模型一次机会补调退出工具，仍失败时由宿主从**同一条最终计划正文**合成审批卡。方案 (b) 直接合成少一轮但更容易把普通说明误判成计划；方案 (c) 保留现状会继续让非 Claude 模型卡在没有审批卡的 plan mode。

### 计划正文的确定性判据

仅在以下条件全部满足时触发：

1. 本轮 session mode 是 `plan`，响应是非空 `type='text'`，没有任何 tool call、取消、拒答错误或强制收尾原因。
2. 规范化正文至少包含两个有序/无序步骤，或一个明确的“计划/实施步骤/文件清单”标题加两条动作项；至少有一个动作词（例如检查、修改、添加、运行、验证）和一个目标（文件、模块、接口、测试或产物）。阈值与词表实现时固定并单测，不能由模型自报“这是计划”。
3. 排除澄清和拒绝：正文以问题为主（疑问句、请求用户补充信息且没有两条动作项），或以不能/无法/拒绝/信息不足等拒绝模式为主且没有计划结构时，不触发。只有一段解释、道歉、状态汇报或空白也不触发。

该判据把“写了计划”定义为**结构化、多步骤、可执行且有目标的正文**，不会把追问、拒绝或普通答案误判成审批计划。

### 运行时行为

- 第一次命中：原文照常落历史，trace 记录 `plan_exit_fallback_detected`（正文长度、结构命中原因、`exitToolCalled=false`），注入一次短提醒：“计划已识别。请调用 `exit_plan_mode` 提交审批；继续保持只读，不要调用写工具。”然后只允许**一次**补推理。补推理仍在 plan/read-only mode，写类工具在 admission 层拒绝。
- 补推理调用退出工具：走现有 `exitPlanMode`，审批卡来源标记 `model_exit`，随后按现有 `shouldEndRunForPlanApproval` 结束 run。
- 补推理仍是结构化计划正文但没有退出工具：宿主合成与 `exitPlanMode` 同形的审批卡，正文逐字保留，来源标记 `synthetic_text`，trace 记录 `plan_exit_fallback_synthesized` 与 `retryCount=1`。卡片必须仍等待用户批准，不能自动进入执行。
- 补推理是澄清、拒绝、空文本或非计划答案：不合成卡；保留现有文本结束语义，并把 `plan_exit_fallback_not_applicable` 写入 trace。最多一次提醒、一次补推理，禁止循环。
- 审批前硬门：`Write`、`Edit`、`Append`、`Bash`、连接器写、MCP 未知/写工具、外部引擎写回全部拒绝或 deferred；合成卡不改变 `permissionMode`，不产生“已批准”事实。

### 账本与用户可见状态

正文消息、提醒、补推理和合成卡都绑定当前 `runId`；trace 记录检测原因、是否补推理、最终来源、卡片 id 和成本。卡片 UI 显示“等待你审批计划”，并区分“模型提交”与“Neo 根据计划正文补出”；用户可以批准、拒绝或继续澄清。`runId` 防止下一轮/旧回放重复合成；审批卡只消费一次。

## 外部引擎结论

不在本 ADR 重做权限翻译。外部引擎先按 `N-ENGINE-PERMMODE-MAP` 接收 `plan → read-only`；若引擎结果回到 Neo 的 plan 会话并满足上述结构判据，Neo host 可以执行同一“提醒一次，失败后合成卡”兜底，因为它只处理 host 已收到的最终正文。若外部引擎有自己的审批协议，适配器必须先完成其协议，再把“待审批”映射回 Neo；Neo 的合成卡不能绕过引擎审批，也不能把 `bypass` 变成 `bypassPermissions`。外部引擎写回仍走 Neo 现有审批边界。

## 批准后拟拆施工单（只提议，不创建）

| 顺序 | 范围 | 触及文件 | 判断标准 |
|---|---|---|---|
| 1（第一刀） | 抽出 plan-text 结构判据、runId 幂等状态和一次提醒/一次重试预算。 | `messageProcessor.ts`、`conversationRuntime.ts`、`reminderBudget.ts`、plan trace 类型 | hermetic 四类：Claude-style 退出工具、计划正文无工具、澄清问题、拒绝；反向变异删除“无 tool call”条件必须红。 |
| 2 | 合成审批卡并复用现有 `exitPlanMode`/`shouldEndRunForPlanApproval` 的边界，不复制权限门。 | `exitPlanMode.ts`、`planApprovalRunBoundary.ts`、审批服务/UI、trace ledger | synthetic 卡能批准/拒绝；批准前写工具始终 deferred/denied；反向变异让 synthetic 结果直接继续 inference 必须红。 |
| 3 | 外部引擎接缝与 N-ENGINE-PERMMODE-MAP 对账。 | `externalEngineSubagentExecutor.ts`、`subagentExecutionRouter.ts`、`spawnAgentEngine.ts` | 外部引擎 plan 只读；写回仍落 Neo 审批；不新增第二套 mode translation。 |
| 4 | 真实运行验收：非 Claude 模型一次、`claude-sonnet-4.6` 一次，固定同一小任务，记录是否调用退出工具、run id、审批卡来源和 USD 成本。 | 现有 chatprobe/eval 驱动与证据档 | 总成本 ≤ USD 1；两次都能判定 `/plan → approval card`，失败则标明具体边界，不重试付费动作。 |

## Decision needed

1. **是否接受“提醒一次后合成卡”这个组合**：建议接受；它保留模型正常退出的首选路径，又给漏调工具的模型一个确定性终点。
2. **是否把“计划结构判据”固定为上述双步骤 + 动作/目标约束**：建议接受，并要求实现票把词表/阈值写成可审计常量与反向变异。
3. **合成卡是否允许用户编辑计划后再批准**：建议允许编辑，但编辑后的文本必须重新绑定同一审批卡版本并重新过写边界；这不改变本 ADR 的触发判据。

验收状态：本设计停在拍板槽；施工单只是提议，未创建。
