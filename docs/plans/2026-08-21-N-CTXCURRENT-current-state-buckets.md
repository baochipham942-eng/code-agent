# N-CTXCURRENT：上下文来源桶语义统一为「当前态」

日期：2026-08-21（爸拍板）
状态：已落地
前置工单：N-CTXPANEL（分桶面板接电 + summary 独立成桶）、N-CTXTRUTH（圆环总量改 provider 真源）

## 决策

`TokenBreakdown.bySource` 七桶语义统一为「当前装进模型的构成」，退役运行时累计账语义。

## 语义演变：累计账 → 当前态

**病**：`bySource` 两种语义混在一张清单里——

- conversation / summary 桶：每轮 `update()` 从消息重算的当前态
- rules / skills / mcp / subagents / fileReads 桶：`recordSourceContribution` 的运行时累计账（只记内存、不落库）

后果：app 重启后点开历史会话，后五个桶归零消失（0 值不占位），像从没挂过。

**为什么收口到当前态**：Cursor / Claude Code / Codex 的上下文面板全是当前态构成，竞品没有「累计归因」形态可抄；「这个 skill 累计烧了多少 token」是账本线（成本/计费）的事，不进健康面板。

## 构成算法（两条路径共用）

新文件 `src/host/context/contextComposition.ts`，纯函数 `computeSourceBreakdown(messages, systemPrompt, hints)`。重算路径（`resolveContextHealthForSession`，重启后历史会话）与运行时路径（`updateContextHealth`，每轮 agent loop）都汇入 `ContextHealthService.update()`，update 内每轮全量重算 bySource，与上轮状态无关。

各桶取数来源：

| 桶 | 取数 |
|----|------|
| rules | 持久化 system 消息里的 `<agents-instructions>…</agents-instructions>` 段估算（agentsHooks 注入后经 SessionStart hook 落库，重启可找回）；消息里没有时兜底扫 systemPrompt |
| skills | `sessionSkillService.getMountedSkillTokens(sessionId)`（新增只读 API）——当前挂载 skill 的 promptContent 估算；未懒加载的触发后台加载，下轮带上 |
| mcp | 扫消息历史：工具名 `mcp__<server>__<tool>`（现行，mcpToolRegistry）/ `mcp_<server>_<tool>`（legacy），按 server 归桶 |
| subagents | `Task` / `spawn_agent`（及别名 `AgentSpawn`/`agentspawn`/`Explore`），按 `subagent_type`/`agentId`/`role` 参数取名归桶 |
| fileReads | `Read` / `read_file` / `read_pdf` / `read_xlsx` / `ReadDocument`（与 renderer humanizeToolStep.READ_TOOLS 同清单） |
| （以上三桶） | 含 assistant toolCalls 参数 + tool 消息结果内容；结果按 `toolCallId → 工具名` 映射归桶，映射不到的留在 conversation |
| summary | 带 `compaction` 标记的摘要消息 content 估算（沿用 N-CTXPANEL） |
| conversation | 扣减法：消息正文+参数+工具结果总量 − 以上各桶，保持弹层九桶合计 = 估算总量 |

provider 真源缩放（N-CTXTRUTH）不变：真源定总量，构成函数定桶值，两单正交——bySource 先按估算口径算出，有真源时等比缩放到 provider 总量。

## 工具命名形态核实（测试钉住）

- MCP：`mcp__github__list_issues` 双下划线（`mcpToolRegistry.ts:341/446`）；legacy 单下划线 `mcp_slack_send_message`（`externalSideEffect.ts` 同款解析口径）
- Read：注册名 `Read`（`read.schema.ts`）；DB/历史里混用 `read_file`（builtInAgents、sessionWorkspace 正则）、`read_pdf`/`read_xlsx`/`ReadDocument`（humanizeToolStep.READ_TOOLS）
- 子代理：`Task`（task.schema.ts）、`spawn_agent`（spawnAgent.schema.ts）；协议别名 `AgentSpawn`/`agentspawn`（toolNames.canonicalToolName）、`Explore`

## 退役清单

- `ContextHealthService.recordSourceContribution / clearSourceContribution / resetSourceContributions / clearMcpServerAcrossSessions` 及 `sourceAccumulators` 累加器、200ms 防抖广播（`emitSourceUpdateDebounced` / `toDisplayState`）全部删除
- 调用点移除：`sessionSkillService`（mount 上报 + unmount 清除，改出 `getMountedSkillTokens` 只读 API）、`agentsHooks`（AGENTS 注入上报）、`mcpInvoke`、`read.ts`、`task.ts`、`spawnAgent.ts`（三处 add 模式上报）、`capabilityCenterService`（2 处）、`mcp.ipc`（2 处 `clearMcpServerAcrossSessions`）
- MCP 禁用/移除后不再跨 session 清桶：历史里仍存在的 MCP 结果属于当前态；新轮次自然不再产生新占用

## 验收对照

1. 重启后历史会话来源桶按当前构成画出：`resolveContextHealthForSession` 走同一个 `update()` → 同一个构成函数，消息从 DB 读出即有值（skills 桶除外——重启后 mounts 为空，当前态语义下本就是 0）
2. 运行中桶值与现状同一量级：rules/skills 沿用原 set 模式口径（AGENTS 段估算、挂载 promptContent 估算）；mcp/fileReads/subagents 从「累计账」变「当前在上下文里的部分」，压缩后自动收窄——这是语义变化后的合理差异
3. 反向变异：`update()` 改回不调用构成函数时，`contextComposition.test.ts` 服务级用例 + 既有 summary/tokenSource 用例立红（本地实测 8 红）
4. i18n：复用现有 `taskStatusPanels.contextHealth` key，未动
5. hermetic 单测：`tests/unit/context/contextComposition.test.ts` 覆盖空会话 / MCP（现行+legacy 命名）/ Read（Read+read_file 变体）/ 压缩摘要 / 挂载 skill+AGENTS 注入 / 子代理 / 无法归因结果留 conversation；service 级接入用例 3 条

## 已知边界（如实记录）

- skills 桶按「挂载列表」而非「历史里实际注入过的 skill 内容消息」取值：skill 经 Skill 工具调用后内容以 isMeta user 消息进历史（这部分同时被 conversation 基底覆盖），挂载估算是从 systemPrompt 侧的归因展开——与原 set 模式口径一致，爸已拍板这个方向
- rules/skills 物理上住在 systemPrompt 里，但从对话基底扣除是 N-CTXPANEL 定稿的混合维度口径（弹层九桶：结构桶与来源桶同表），不是双计 bug
