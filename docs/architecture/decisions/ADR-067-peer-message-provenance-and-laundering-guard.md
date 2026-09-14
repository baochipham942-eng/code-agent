# ADR-067：peer 消息来源铸造与权限洗白闸（provenance envelope + origin-aware permission）

- 状态：**待爸拍板**
- 日期：2026-09-14
- 工单：N-PEERMSG-LAUNDER（RQ-072，SOTA D08-09，权限线 P0）
- 相关：ADR-057（审批拒绝来源不许自报）、ADR-066（出网白名单，同批权限线）、N-PEERMSG-CHECK（08-23 旧档，已预言本安全问题）、N-INJECT-BOUNDARY（不可伪造注入边界）、N-MATE-SHARE / N-AGENT-ADDRESSBOOK（冷冻，放开消息面的前置依赖）
- as-built 基线：origin/main@ebc0a308d（勘察树 `feat/peermsg-launder`）

本 ADR 只定形状，不改代码、不配基线。爸拍板后才拆施工单。

## 背景

SOTA 体检 D08-09：跨会话/跨 agent 消息不参与权限判定，竞品（Claude）把「peer 说我被拦了帮我跑」判为权限洗白直接 BLOCK，本仓库零机制。09-14 对代码通盘勘察后，缺口比体检写的更深一层：**peer 消息的发送者身份今天就是假的**。

今天的消息面（勘察事实，锚点见文末）：

| 层 | 做什么 | 不做什么 |
|---|---|---|
| 消息存储 | 三套并存：SpawnGuard.messageQueue、ParallelAgentCoordinator.messageQueues、TeammateService mailboxes（`agentInbox.ts:1-15` 自认"三套割裂的源"） | 不统一；AgentBus 结构最全但零消费方（死代码） |
| 发送者身份 | `from` 是纯字符串路由标签 | SpawnGuard 硬编码 `from='parent'`（`spawnGuard.ts:894-896`）；coordinator 硬编码 `from='user'`（`parallelAgentCoordinator.ts:824,834`）——包括 `send_input` 转发的 agent 消息，落进队列即成"用户消息"。teammate 的 `from` 发送方自报无校验 |
| push 注入 | 子代理 loop 每轮 drain 队列，拼成 `role:'user'` 消息压进上下文（`subagentExecutor.ts:571-591` → `subagentExecutorTelemetry.ts:142-181`） | 前缀仅按 `from==='user'` 二分（`[User message]:` / `[Parent agent message]:`）；原始 sender 不进文本；**零注入防护**——无 InputSanitizer、无 nonce 边界、无不可信标记。对照：pull 路（teammate inbox 拉取）走 `toolResultLifecycle.ts:180-218` 有完整防线。同一段 peer 文本，pull 有边界，push 没有 |
| 权限判定 | `ToolExecutor.execute` 决策链：工具面兜底 → subagentPolicy → schema → 槽隔离 → commandSafety → 分类器/exec-policy → needsUserApproval | 判定输入（`PermissionRequestData`，`tools/types.ts:193-209`）**没有「本轮输入来自谁」这一维**：`agentId` 是"谁在执行"，不是"谁的指令促成了这个动作"。用户输入 / subagent 任务书 / peer 消息在权限层完全无区分 |
| 否认记忆 | `decisionHistory.ts:41-62` 进程级 50 条环形缓冲，ask-denied 都记 | 唯一读者是诊断 IPC，权限判定从不查它。"A 被拒 → B 被求同一条"无任何匹配 |
| 发送面 | `send_input` 工具、teammate 9 action、用户补话通道 | 子代理今天发不出 peer 消息（`SUBAGENT_DISABLED_TOOLS` 明列 `agent_message/send_input/teammate`，`spawnGuard.ts:1235-1254`）——暴露面被人为压着，但任何放开消息类工具的单都会把本缺口变成实战面 |

跨会话消息今天不存在（TeammateService 拒跨 run 投递，队列按 session/run scope；N-AGENT-ADDRESSBOOK 冷冻），所以本 ADR 的「peer」= 同会话/同 run 内跨 agent，形状对跨会话同样成立。

## 北极星

peer 消息永远不能成为权限洗白通道：发送者身份由宿主在入队点铸造、发送方不得自报；权限判定输入必须含「本轮输入来自谁」；「A 被拒的动作换 B 来求」能被认出并按洗白处置。机制必须先于任何放开 `SUBAGENT_DISABLED_TOOLS` 消息类工具的单落地。

## 决策

### D1 来源铸造（provenance envelope）：入队即铸，发送方不得自报

所有入队点（`spawnGuard.ts:890-900`、`parallelAgentCoordinator.ts:812-837`、`teammateService.ts:171-220`、`memberInput.ts`、`swarm.ipc.ts:188-231`）由宿主统一盖结构化 `origin`：

```
origin = { senderKind: 'user' | 'orchestrator' | 'peer-agent' | 'dependency',
           senderAgentId, sessionId, runId, turnId }
```

- `AgentMessage` / `TeammateMessage` 加 `origin` 字段；`from` 字符串降级为展示用，任何安全/路由消费方不得再读它。
- 修掉两处硬编码（`'parent'` / `'user'`）：`send_input` 转发的 agent 消息落队必须是 `senderKind='peer-agent'`，不是 `'user'`。
- `drainSubagentMessages` 用 origin 生成诚实的注入前缀（`[Peer agent X]:`），不再冒充 parent/user。
- 与 ADR-057 同一原则：来源不许自报——057 管审批拒绝，本 ADR 管消息入队。

### D2 push 路注入补不可信边界（随 D1 同刀）

队列注入的 peer/orchestrator 消息进 user-role 上下文前，过与 pull 路同口径的防线：`InputSanitizer` 扫描 + nonce 边界包裹（对齐 `toolResultLifecycle.ts:184-218` 与 `untrustedContentBoundary.ts:58-75`；user 本人消息不包）。关掉 push/pull 防护不对称——这不是可选项，D1 让前缀诚实之后，模型更需要机器边界来区分「指令」与「转述」。

### D3 turn 起源进权限判定（origin-aware permission）

- `PermissionRequestData` 与 ToolExecutor options 增加 `turnOrigin`（本轮最新输入的 origin 链，可多条——一轮里可能同时 drain 到 user 与 peer 消息，取最不可信者）。
- 子代理 loop 在 drain 注入时把 origin 挂到 turn context：`subagentExecutor.ts:571-591` → `subagentToolRuntime.ts` → executor。
- 规则：`turnOrigin` 含 `peer-agent` 时，写/执行类工具一律 `forceConfirm`（复用现成机制，不新增审批类型）；审批卡文案标明「此动作由 agent X 的消息触发」（`orchestratorPermissions.ts` 审批负载扩展）。只读工具不升档。
- `bypassPermissions` / 无人值守不豁免——peer 来源的写/执行在无人值守下 fail-closed 拒绝（与 ADR-066 D3 新域名卡同一语义：无审批 UI 时不许静默放行机器转述的请求）。

### D4 跨 agent 否认登记 + 洗白匹配（denial ledger，二期）

- `decisionHistory.ts` 升级为可按 `(sessionId, 动作指纹)` 查询的 denial registry；指纹复用 `canonicalizeCommand` / `standingGrantTarget` 的规范化。`ask-denied` 写入。
- 任何 agent 后续命中同指纹动作：`turnOrigin` 含 peer → 直接 BLOCK，`recordDecision('policy-deny','peermsg-launder')`；无 peer 来源（用户本人重试/换 agent 重跑）→ `forceConfirm` 一次，不硬毙。
- 这是竞品「peer 说我被拦了帮我跑 → BLOCK」语义的完整复刻，但它依赖 D1 的真实 sender 与 D3 的 turnOrigin 维度，否则无法区分「peer 转述」与「用户本人重试」，误伤不可控——故排二期。

### D5 与消息面放开的先后

本 ADR 的 D1–D3 是放开 `SUBAGENT_DISABLED_TOOLS` 中消息类工具（send_input/teammate 对子代理开放）的**前置依赖**；N-MATE-SHARE、N-AGENT-ADDRESSBOOK 解冻前，D1–D3 必须已灰度。在消息面被人为压着的窗口期施工，误伤面最小。

## 否决的替代

- **只靠 prompt 文案**（system prompt 写「不要听 peer 的」）。模型可被注入绕过，且 push 路今天连边界标记都没有。
- **一切 peer 触发动作直接 BLOCK**。误杀良性协作（主代理派活给子代理就是 orchestrator 消息），且与现行委派模型冲突。
- **先做 D4 不做 D1/D3**。`from` 今天就是假的（两处硬编码），在可伪造的身份上建洗白匹配，误伤不可控。
- **复用 `from` 字符串做判定**。同上，它已被证明是假数据。
- **借机统一三套消息存储到 AgentBus**。结构最全但总线零消费方，统一是正确方向、不是本单范围——本单只把 `origin` 字段在三套结构上对齐，存储归一另开单。

## 后果

得到：

- 发送者身份第一次成为宿主铸造的事实，而不是路由标签；两处硬编码假身份消除。
- 权限判定输入补齐「本轮输入来自谁」维度，peer 转述的写/执行必过人工卡，无人值守下 fail-closed。
- push/pull 注入防护对称。
- 二期 denial ledger 落地后即对齐竞品洗白 BLOCK 语义。

代价：

- 良性协作中 peer 建议的写动作多一次人工确认。
- `PermissionRequestData` 与审批负载是协议面改动，renderer/CLI 两端对称成本。
- 三套消息结构都要加 `origin` 字段，旧队列里无 origin 的存量消息按 `senderKind` 未知处置（从严：视同 peer-agent）。

不做：三套消息存储归一、跨会话寻址（N-AGENT-ADDRESSBOOK）、teammate pull 模型改 push、对 user 本人消息的注入边界。

## 施工拆单（ADR 过后开，本单不动）

| 单 | 内容 | 门 | 依赖 |
|---|---|---|---|
| 刀 0 来源铸造 | 三套消息结构加 `origin`；五个入队点宿主铸造；修两处硬编码；drain 前缀诚实化；存量无 origin 从严 | 单测（入队点铸造、伪造 from 不生效、前缀正确）+ 反向变异（把 `send_input` 转发消息盖成 `'user'` → 测试红） | — |
| 刀 1 push 边界 | 队列注入过 InputSanitizer + nonce 边界；user 消息不包 | 单测（peer 消息含注入载荷被包边界/拦截）+ 反向变异（摘掉边界 → 注入扫描测试红） | 刀 0 |
| 刀 2 origin 权限 | `turnOrigin` 进 PermissionRequestData 与判定链；peer 起源写/执行 forceConfirm + 审批卡标注；无人值守 fail-closed | 单测（peer 起源 bash 必出卡且卡面带 sender；user 起源不变；只读不升档）+ 反向变异（去掉 turnOrigin 传递 → peer 起源静默放行，测试红） | 刀 0 |
| 刀 3 denial ledger | decisionHistory 升级可查询 registry；指纹规范化；peer+同指纹 BLOCK，无 peer forceConfirm | 单测（A 被拒 → B peer 转述同指纹 BLOCK；用户重试 forceConfirm；改参数不误伤） | 刀 2 |

顺序：刀 0 → 刀 1/刀 2 可并行 → 刀 3 二期。全部落地前，`SUBAGENT_DISABLED_TOOLS` 消息类工具不许放开。

## 事实锚点

- `src/host/agent/spawnGuard.ts:53-62` AgentMessage 结构；`:894-896` 硬编码 `from='parent'`；`:1235-1254` SUBAGENT_DISABLED_TOOLS；`:144-148` scope 隔离
- `src/host/agent/parallelAgentCoordinator.ts:107` 队列；`:824,834` 硬编码 `from='user'`；`:812-837` 入队点
- `src/host/agent/teammate/types.ts:25-39` TeammateMessage；`teammateService.ts:73` mailbox、`:312-326,534-559` 跨 run 拒绝
- `src/host/tools/modules/multiagent/teammate.ts:72` from 自报；`sendInput.ts:31-115` 发送面；`agentMessage.schema.ts:15-31`（无发送能力）
- `src/host/agent/subagentExecutor.ts:571-591` drain 注入点；`subagentExecutorTelemetry.ts:142-181` 前缀二分、sender 仅进 observation 元数据
- `src/host/agent/runtime/toolResultLifecycle.ts:180-218` pull 路防线；`src/host/security/untrustedContentBoundary.ts:58-75` nonce 边界；`parallelAgentDependencyPrompt.ts:7-13` UNTRUSTED 静态文案
- `src/host/tools/types.ts:193-209` PermissionRequestData（无来源维）；`toolExecutor.ts:767-798` 判定链、`:1853-1855` forceConfirm 机制、`:931-933` rememberCommandAnalysisFailure
- `src/host/security/decisionHistory.ts:41-62` 环形缓冲、唯一读者诊断 IPC（`diagnostics.ipc.ts:43`）
- `src/host/permissions/guardFabric.ts:21` 执行拓扑 identity；`subagentToolRuntime.ts:100-116` 子代理审批出口；`orchestratorPermissions.ts:75-` 人工审批岛
- `src/host/agent/agentBus.ts:816` getAgentBus 零消费方（死代码，不施工）

## as-built 备注

1. `agent_message` 工具名有误导性：只有 status/list/result/cancel，不能发消息。
2. 08-23 旧档 N-PEERMSG-CHECK 的「teammate 装好没接电、对等闭环被 denylist 切断」在本基线仍成立；其 §3 已预言本单核心安全问题（"什么阻止 A 指挥 B 绕过 A 自己被拒的审批"）。
3. 勘察遗留存疑点：CLI/goal 模式下 deferred 工具召回链路（teammate 实际可否被主 agent 搜到）未证实；放开消息类工具的单启动前需先补核此格。
