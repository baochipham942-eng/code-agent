# ADR-052：会话与专家的关系——不设「会话的当前专家」，turn 级身份由宿主解析

- 状态：已采纳（2026-07-25 产品负责人拍板：选 C，fallback 先宽 + 打点统计漏传率）
- 日期：2026-07-25
- 相关：ADR-049（能力中心 —— 一个能力只有一个家）、#671（专家可声明推荐连接器）、#637（per-role 三档权限）

## 背景

#671 让专家能在 `agent.md` 里声明推荐连接器（`core` 默认开 / `optional` 默认关），并提供三态解析 `resolveSessionConnectorIds`（会话覆盖 > 专家默认 > 全局）。但**运行时收窄没有做**。核实结果（2026-07-25 逐处 grep 与读码）：

1. `resolveSessionConnectorIds` 的调用方**只有 renderer 的专家详情页**（`RoleDetailPage.tsx`，用于展示"哪些默认开"）。宿主侧一次都没调用。
2. 宿主真正的工具收窄发生在 `buildWorkbenchToolScope`（`src/host/app/workbenchTurnContext.ts:409`），它的输入是**会话信封的 per-turn 上下文**——`context.selectedConnectorIds` / `selectedSkillIds` / `selectedMcpServerIds`，由 renderer 每轮填。
3. `sessions` 表**没有任何角色/专家列**（21 列里没有 roleId 之类）。会话契约里也没有。
4. 会话信封的 context **不带 roleId**，只带 `targetAgentIds`（Direct 路由用）与三个 `selected*Ids`。

也就是说：专家目前不是会话的属性，而是**被 spawn 出来的 agent**。而且一个会话可以同时有**多个**成员（团队态 `agents.length > 1`，见 `SessionMemberBar.useSessionMembers`）——所以"这个会话的当前专家是谁"在团队态下本身就是个没有唯一答案的问题。

## 要回答的问题

一个会话的「当前专家」是否该成为一等概念？它会影响四件事：连接器收窄、per-role 权限档、角色记忆归属、成员条。

## 三个选项与代价

### A. 不建绑定，renderer 每轮把解析结果填进信封

renderer 组信封时调 `resolveSessionConnectorIds`，把结果写进 `selectedConnectorIds`。

- 改动最小，宿主零改动，当天能落。
- **代价（致命）**：每个入口都要**自己记得填**。cron 自动化、无人值守、子代理 spawn、CLI 这些**非 renderer 入口天然填不上**——收窄于是只在"人手动聊天"时生效，自动化路径全漏。而自动化恰恰是最需要收窄的场景（没人盯着）。
- 而且 renderer 会成为第二套规则的定义方，与 ADR-049「一个能力只有一个家」相悖。

### B. 会话一等绑定（`sessions` 表加角色列）

- 一次绑定，所有入口（含 cron / 子代理 / CLI）都能查到，收窄、权限档、记忆归属、成员条四件事有统一真源。
- **代价**：① 需要 DB 迁移；② 必须回答"团队态怎么办"——一个会话多个成员时，单一 `roleId` 要么是谎言，要么得变成列表，那就等于把成员表复制一份；③ 必须定义"中途换专家"的语义（改绑定？还是开新会话？）——这是产品决定，不是技术决定；④ 与现有心智（专家 = 被 spawn 的 agent）冲突，成员条、Direct 路由都要跟着改口径。

### C（已采纳）. turn 级身份，由**宿主**解析

宿主在 turn 上下文处拿到「这轮谁在说话」，自己去读该专家的 `agent.md` 声明并解析连接器。

> **实现时的更正（2026-07-25）**：本文初稿写的是「信封 context 增加 `roleId`」——**这一步不需要**。
> 落地前复核发现身份链早已端到端存在，只是没人拿它去收窄：
> renderer 按会话持久化 `activeAgentId`（`activeAgentSessionMap.ts`）→ 信封 `preferredAgentId`
> → `workbenchTurnContext.ts:451` 映射成 `options.agentOverrideId`；cron 侧
> `buildCronAgentRunOptions` 直接返回 `agentOverrideId: roleId`；团队配方每个成员也各自带 `roleId`。
> 对角色资产而言 `AgentListEntry.id` 就是 roleId。所以契约零新增字段，只在
> `withWorkbenchTurnSystemContext` 里把「身份 → `resolveAgent(id).connectors` → `resolveSessionConnectorIds`」接上。

- 收窄逻辑**只有一个家**（宿主），renderer 不再定义第二套规则，符合 ADR-049。
- 不动 `sessions` 表，不需要迁移，不需要回答"会话的唯一专家是谁"——团队态下每条 turn 各自带自己的 `roleId`，天然多成员正确。
- 自动化入口也能填（cron 派活时知道派给谁），比 A 覆盖面大得多。
- **代价**：`roleId` 要在每条 turn 上正确传递，漏传就退回"不收窄"（安全默认是宽的，不是紧的）；per-role 权限档若也走这条路，要确认 `toFullAgentConfig` 那条链能接住（#637 已通，但要复验）。

## 建议

选 **C**。理由一句话：**"会话的当前专家"这个概念在团队态下本身不成立**，硬把它做成一等概念是在给一个不存在的实体建表；而 turn 级 `roleId` 既能让宿主成为收窄逻辑的唯一家，又天然兼容多成员。

A 的问题不是"简陋"，是**安全收窄只覆盖有人盯着的路径**，恰好漏掉最该收的自动化路径。

## 拍板结果（2026-07-25）

1. **选 C**。
2. 漏传时**退回不收窄（宽）+ 打点统计漏传率**——先让它跑起来不打断任何现有路径，
   用真实数据看清哪些入口会漏，再决定收紧到什么程度。拿数据收紧，不拍脑袋收紧。

## 落地范围与边界

已落地：连接器收窄 + `expert_scope_identity` 打点（`present` / `source` / `declaredConnectors`）。

**明确不在本次范围**：per-role 权限档（#637 已通，但走的是另一条链）、角色记忆归属、成员条口径。
它们同样能受益于 turn 级身份，但各自有独立取舍，另行立项——本次只把「声明了连接器却不生效」
这一条真空补上。

fallback 收紧的触发条件：等 `expert_scope_identity` 的 `present=false` 占比数据出来后重新评估。
