# ADR-033 — Neo Tag 跨会话 Topic（@neo 续接不被发起会话困住）

- 状态: proposed（待产品负责人拍板）
- 日期: 2026-07-02
- 相关: ADR-032（轻量化重设计，本 ADR 的地基）、ADR-031（运行时安全护栏，不受影响）、`src/shared/contract/tag.ts`、`neoTagRuntimeService`、`neoTagContextSelector`、`projectCollaborationData.ts`
- 触发: 轻量化重设计收尾后，topic 仍绑死发起会话——用户在别的会话无法续接一个已交代给 Neo 的 topic，Neo 也拿不到跨会话上下文。

## 北极星

topic 是用户交代给 Neo 的「一件事」，不是「某个会话里的一次调用」。用户在任何会话都能续接它；续接时 Neo 带着这个 topic 的历史轮上下文干活；过程像正常聊天一样在用户眼前流式展开。

## 现状与差距（已代码核实）

| 环节 | 现状 | 差距 |
|---|---|---|
| 发起 | 每次 `@neo` = `createAndRunNeoWorkCard` 新建卡，`sourceConversationId` 绑死发起会话 | 同一件事的追问也会裂成新卡，topic 无法生长 |
| 执行 | `launchApprovedNeoWorkCard` 永远 `startTask(sourceConversationId)`，回源会话跑 | 在会话 B 续接，过程会跑去会话 A，用户眼前没动静 |
| 上下文 | `readScope.conversationIds` 是数组但只 seed `[sourceConversationId]`；**模型真正的上下文来自"run 跑在源会话里"这一事实**（prompt 层只列消息 ID 不含正文） | 跨会话后源 topic 的正文必须物化进 prompt，否则 Neo 是失忆的 |
| 回溯 | 每轮锚点 = 用户消息 `metadata.neoTag.workCardId`（renderer/host 同 `sourceTurnId` 落库去重）；`extractNeoTopicRounds` 只扫单会话 | 轮的**会话归属没有落库**——卡不知道自己在哪些会话里发生过，详情无从聚合 |

## 决策点

### D1 续接模型：用户怎么指到既有 topic？

**决策：@neo 下拉带「最近活跃 topic」候选，选中 = 同卡追加一轮；默认（不选）仍是新建 topic。topic 详情页同时提供追问入口。**

交互（复用现有 mention 机制，`neoMentionRouting.ts` 的合成候选模式）：

- 输入 `@neo` → 下拉除现有「Neo」项外，追加最近活跃 topic（`listAll` 取非 archived、按最近活动排序、前 5 条），每条显示标题 + 相位 + 最近活动时间。
- 选中某 topic → composer 挂一枚可移除的「续接：<topic 标题>」chip（同 `AgentChip` 的既有 chip 形态），正文仍是 `@neo <要说的话>`。**不做文本编码**（不在消息文字里塞 workCardId）——chip 是 composer 态，脆弱的文本解析一概不引入。
- 不选 topic 直接发 → 行为与今天完全一致：新建 topic。**默认新建、续接显式**，用户心智可预测，不做"自动猜你要续哪个"的魔法。
- topic 目录详情页加一个轻量追问输入框，发出 = 同一条续接链路（在详情页续接时执行落点见 D2）。这条几乎免费：底层与 chip 续接走同一个 IPC。

否决的候选：
- 「@neo 默认续上一个 topic」：歧义太大，用户多数时候是交代新事。
- 「只在详情页续接」：把续接埋进目录，违背「@neo = 正常聊天」——用户在会话里自然地说话才是主路径。

### D2 执行落点：续接的这轮在哪个会话跑？（最大架构决策）

**决策：在当前会话跑（方案 B）。** 这是北极星的直接推论——「@neo = 正常聊天」意味着我在哪儿说话，Neo 就在哪儿回我；过程流式可见是轻量化重设计（ADR-032）拿掉审批卡后仅剩的信任来源，不能丢。

两边利弊写透：

| | A. 仍回源会话跑 | B. 在当前会话跑（选定） |
|---|---|---|
| 改动量 | 极小（launch 不动） | 中（下述 4 项） |
| 用户体验 | 在 B 说话、回复出现在 A——用户眼前零动静，等于把审批门换成了失踪门 | 说哪儿答哪儿，与普通聊天无差别 |
| 数据模型 | 不动 | 卡要支持多会话轮（轮的会话归属落库） |
| 上下文 | 免费（session 历史就在） | topic 历史必须物化注入（本来就是 D3 要做的） |
| 回溯/详情 | 不动 | 按会话聚合（D4） |

B 的代价拆解（全部是加法、零破坏）：

1. **轮的会话归属落库**：`NeoWorkCardDelta` 增加可选字段 `conversationId`（额外一列，老数据为 NULL 时回退 `workCard.sourceConversationId`）。不新建表、不改 `workCard.sourceConversationId` 语义——它退化为「发起会话」这一不可变出处记录。卡参与过的会话集合 = distinct(delta.conversationId) ∪ {sourceConversationId}。
2. **launch 支持目标会话**：`launchApprovedNeoWorkCard` 增加可选 `targetConversationId`（缺省 = sourceConversationId，向后兼容），`startTask` 打到目标会话；每轮消息 metadata（workCardId/runId/sourceTurnId 机制）原样保留，续接轮生成新的 turnId 同 ID 落库去重——**现有锚点机制不动**。
3. **工作目录跟 topic 走、但只作用于该 run**：topic 的工作目录 = 源会话工作目录。续接在 B 跑时，该 run 用 topic 工作目录，但**不得持久改写会话 B 的工作目录**（现状 `setWorkingDirectory` 是会话级持久设置，直接复用会污染 B 的后续普通聊天——实现时按 run 级传递，若 AgentRunOptions 不支持则先跑 B 会话自己的目录并在详情里如实展示，作为 Phase 内明确任务处理，禁止静默污染）。
4. **并发护栏**：同一张卡在跑（相位 running/needs_input）时拒绝续接，前端友好提示「这个 topic 还在跑，等这轮结束再续」。避免同卡双会话并发写 delta 的竞态。fail-closed，与 ADR-031 思路一致；ADR-031 护栏本身按 neoTag 上下文生效，与会话无关，零改动。

### D3 跨会话上下文：Neo 续接时带什么记忆？

**决策：打通 `readScope.conversationIds`，会话集合自动推导，不做手动多选 UI；跨会话正文以「topic 历史轮」形态物化进 prompt 层。**

- **谁来选会话**：续接时 `conversationIds = [当前会话, ...该卡历史轮出现过的会话]`（从 delta.conversationId 推导），自动、去重、无 UI。用户不该为「Neo 记不记得」做配置——记得是本分。
- **注入什么**：不是把别的会话原样灌进去。prompt 层新增「Topic 历史」段：每轮的用户原话 + Neo 最终回复（正是 `extractNeoTopicRounds` 的产出形态，复用其提取逻辑并沿用 `isInternalRuntimeText` 滤掉引擎记账文案），按时间序、最近优先。
- **token 预算**：topic 历史段独立预算（初值 4000 tokens，封顶随 `buildNeoTagContextPack` 现有 800~24000 界内），超出从最老的轮截断，截断行为写进 context audit（`summarizeContextAudit` 已有账本，加一项 topicRounds 计数）。
- **当前会话**：run 跑在当前会话里，session 历史天然在场，不重复注入。
- `buildNeoTagContextPack` 从「单会话 messages 入参」改为接受多会话消息集（runtime 侧对每个 conversationId 各取最近 80 条再交给 selector 截断），`readScope.conversationIds` 从死字段变成 selector 的真实过滤依据。

### D4 详情兼容：多会话后 topic 详情怎么回溯？

**决策：按会话集合聚合。** `extractNeoTopicRounds` 保持单会话纯函数不动，详情层对卡的会话集合（同 D3 的推导）逐会话拉消息、逐会话提轮、按时间戳合并排序。每轮标注所属会话，「打开会话」从卡级按钮变为轮级跳转（跳到该轮真正发生的会话）。老卡（无 delta.conversationId）自然退化为单会话行为，零迁移。

## 不做的事（明确出界）

- 手动多选会话 UI —— 自动推导足够，配置面 = 负资产。
- 自动把「相关会话」（非本 topic 的轮）纳入上下文 —— 语义检索式的召回另立项，本轮只带 topic 自己的历史。
- topic 合并 / 拆分 / 改绑 —— 等真实使用暴露需求再说。
- 契约硬减重（ADR-032 已 deferred 的 approval/revision 层清理）—— 不搭车。

## 实施分期（拍板后 TDD，每段 commit + typecheck + 测试）

1. **Phase 1 契约 + host**：`delta.conversationId`（契约 + DB 加列 + repo）、`launchApprovedNeoWorkCard` 目标会话参数、续接 service 路径（既有卡追加新 revision → 自动批准 → launch 到当前会话；含并发拒绝、completed 卡可续接重开）、context selector 多会话入参 + prompt 层 Topic 历史段。
2. **Phase 2 renderer 发起侧**：@neo 下拉 topic 候选 + 续接 chip + 提交链路带 workCardId；续接轮用户消息本地补显（沿用 sourceTurnId 同 ID 去重机制）。
3. **Phase 3 详情聚合**：多会话轮合并 + 轮级「打开会话」+ 详情页追问入口。
4. **Phase 4 dogfood**：Dev 包真装，会话 A 发起 → 会话 B 续接一次，验证过程在 B 流式可见、Neo 复述 A 轮上下文正确、详情两轮聚合、老 topic 显示不回归。

## 风险

- **工作目录 run 级隔离**是 Phase 1 的硬点（见 D2-3），若 AgentRunOptions 不支持须显式暴露而非静默污染会话 B。
- 多会话消息拉取放大 IO（每会话 80 条）：会话集合实际规模 = topic 参与过的会话数（通常 ≤3），可接受；selector 有 token 硬顶。
- 详情聚合是 renderer 侧多次 IPC 拉取：沿用现有 `fetchConversationMessages` fail-safe（失败静默空），单会话失败不拖垮整个详情。
