# Agent Neo 执行轨迹渲染统一 Spec

> 命题：用户反馈「执行中乱 / 失败报错噪音特别大 / live 态和切历史态不一样」。本 spec 对标 Codex CLI / Kimi CLI / Claude Code 的 history-cell 渲染，提炼统一方案。**排进 2c（布局收口）**。
> 日期：2026-06-25。来源：竞品源码调研（Codex/Kimi 逐行核实，Claude Code 官方文档+issue）+ Neo 现状双向映射（file:line 见各节）。

## 0. 先纠正一个判断
早前以为 Neo「live 走 `TurnBasedTraceView`、history 走 `MessageBubble` 两套渲染」——**错**。实测：**live 和 history 都走 `TraceNodeRenderer`（统一渲染器），`MessageBubble/AssistantMessage` 是死代码**（ChatView 不引用）。真正的分叉是三处：
1. **数据持久化**：`hook/skill/artifact` 等 `turn_timeline` 节点是实时临时生成的、**没存库**（`turnTimelineProjection.ts` 只在 live 注入）→ 切历史就丢，所以「跑时有 hook、切回来没了」。
2. **live 态内部聚合不一致**：思考碎成多块、首次搜索单列+其余聚合计数混用。
3. **失败渲染多重叠加 + 原始错误全量 dump**（噪音主源，见 §5）。

## 1. 竞品金标准（提炼）
三家不同栈（Rust trait / Python rich.Live / JS Ink）收敛到同一套契约：

| # | 原则 | 出处 |
|---|---|---|
| P1 | **committed history + 单个 active cell**：完成的 cell 不可变进 scrollback，只有在跑的 cell 原地变 | Codex `active_cell` slot；Kimi `rich.Live(transient)`+flush；CC Ink `<Static>` |
| P2 | **一个逻辑步=一个稳定 cell，running→done 原地 mutate**（按 callId 认领，不是 append 第二个结果块） | Codex `complete_call`；Kimi `finish()` |
| P3 | **状态用一个会原地切换的 glyph 表达**：spinner→绿→红 + 用时/退出码挂同一行 | Codex `• green/red`+`✓/✗`；Kimi spinner→green/dark_red |
| P4 | **同类连续动作聚合、不刷屏**：read/list/search 并进一个 Exploring/Explored | Codex `ExecCell{Vec<ExecCall>}` |
| P5 | **reasoning 暗色+合并成一块**（绝不每段 delta 一个块） | Codex `ReasoningSummaryCell` dim+italic；Kimi dimmed 一行；CC gray italic |
| P6 | **流式在安全边界提交**：只 newline-complete 进稳定区，未完部分是单个被替换的 tail（一条消息一个 header） | Codex `controller.rs` table-holdback；Kimi `_committed_len` |
| P7 | **两级详情**：紧凑 live 视图 + 可展开完整 transcript | Codex `display_lines`/`transcript_lines`；CC ctrl+o/ctrl+r |

**失败**：F1 失败=同 cell 红 glyph + 一行原因 + body 硬 cap（Codex 非用户工具 **5 行** / 用户命令 **50 行**）+ 显式「展开/transcript」；F2 致命/顶层/API 错误（429/余额/超载）**escalate 成 banner，不进 cell、可不截断**（Codex `new_error_event` / CC `API Error:` banner）。
**MCP**：每次调用=普通 tool cell（`server.tool(args)`，同 glyph 同 cap）+ server 连接/健康**单独 surface**（不混进 transcript）。
**Nested/subagent**：折叠成**一个父 cell**，子调用 **bounded**（Kimi `deque(maxlen=4)` + 「{n} more …」/ CC 只回最终消息、完整子树进侧栏+独立 jsonl），**绝不把嵌套子调用平铺进主轨**。

## 2. Neo 现状 vs 金标准（gap）
| 原则 | Neo 现状 | 文件锚点 | gap |
|---|---|---|---|
| P2/P3 原地更新 | 流式 overlay 已原地 mutate assistant_text + tool `_streaming` 标志 | `streamingProjectionOverlay.ts` | ~OK（但非全类型 cell 化） |
| P4 同类聚合 | 有 `groupAdjacentToolCalls`/`ToolStepGroup` | `toolStepGrouping.ts:138` | **聚合不一致**：首次搜索单列、其余「Searched N」计数 |
| P5 reasoning 合并 | live 有 promoted-progress 提取，但思考可碎成多块 | `TraceNodeRenderer.tsx:346-505` | 思考分块，未强制合并 |
| hook 展示 | `HookExecutionBanner`「执行了 N 个钩子」 | `TurnCard.tsx:145-186,302-433` | 位置漂忽（顶上一行）+ **没持久化→history 丢** |
| F1 失败去噪 | 失败被渲染 **3~4 遍** + 未识别错误**原始 JSON/ANSI 全量 dump** | 见 §5 | **噪音主源** |
| MCP | 紫 Plug 图标 + 通用「调用失败」，错误走通用 raw dump | `utils.ts:357-365`/`statusLabels.ts:83-86` | 无 server health surface、错误不 cap |
| nested | workflow stage 错误全量不截断；`spawn_agent` 无聚合 | `ToolCallDisplay/index.tsx:312-371` | 子错误不 cap、无 bounded children |
| live/history 同源 | 渲染器统一，但 timeline 事件不持久化 | `turnTimelineProjection.ts` | history 丢 hook/skill/artifact |

## 3. 目标渲染模型（统一 cell taxonomy）
转录区 = **不可变 committed cells + 少量 active cells（按 callId 认领、原地 running→done）**。Cell 类型与各自 running/done/error 渲染：

| Cell | running | done | error |
|---|---|---|---|
| `user` | — | `›` 前缀 | — |
| `agent-text` | 单个被替换的 tail（P6） | 一条消息一个 header | — |
| `reasoning` | 暗色一行 spinner+用时（P5） | 暗色折叠「思考 {用时}」一块 | — |
| `tool-call` | spinner glyph + `工具名(参数)` | 绿 glyph + 用时 + 结果摘要 | **红 glyph + 一行原因 + 折叠详情(cap)** |
| `mcp-call` | 同 tool（`server.tool(args)`） | 同 tool | 同 tool（错误 cap 5 行） |
| `hook` | — | 固定「钩子」轨道（带名字/用时），**持久化** | 红 + 一行 |
| `skill/subagent` | spinner | **折叠父 cell**：bounded children + 「{n} more」 | 父 cell 红 + 一行 |
| `notice/api-error` | — | — | **banner（escalate 出 cell，可不 cap）** |

## 4. 聚合规则
1. **搜索/读取等同类**：统一一个「搜索 (N)」组、组内列每条 query（可展开），**禁止**首条单列 + 其余计数混用。
2. **reasoning**：连续 reasoning 强制合并成 1 个暗色可折叠块，不切碎。
3. **hook**：固定语义位（每轮同一栏，带名字/用时），醒目但归位（**用户要的「明显」满足，但不漂忽**）。
4. **status**：所有 cell 用同一套 glyph（spinner→绿→红）+ 用时挂同行。

## 5. 失败去噪（P0，噪音最痛）
**现状噪音源（实测）**——同一个 429 被渲染 4 遍 + 原文 dump：
- 组头 `failed` + 错误摘要截断（`ToolStepGroup.tsx:153-179`）
- loop 决策「工具报错」chip（`ToolCallDisplay/index.tsx:335-349`）
- 工具行红边自动展开（`ToolCallDisplay/index.tsx:105-147`）
- 展开里**未识别错误原始 JSON/ANSI 全量铺**（`ToolDetails.tsx:266-281`，常 300+ 字符不截断）
- Bash 即使成功也显示「已执行（退出码 255，结果可能不可靠）」自相矛盾（`statusLabels.ts:139-145`）
- humanize 只认 quota/credit，429/401/超时全漏（`toolExecutionPresentation.ts:108-130`）

**目标**：
1. **一个错误只在一处主渲染**：失败 = 该工具 cell 红 glyph + **一行原因**（humanize 后），详情**默认折叠**、cap 5 行（用户主动 shell 命令 50 行）、超出给「展开」。去掉组头摘要 + loop chip 的重复错误信号（组头只留红点+「N failed」计数，不重复错误文本）。
2. **扩展 humanize**：加 HTTP 429/401/403/超时/余额/超载/网络 的识别，统一成「{什么}失败：{一句人话} + 操作按钮（重试/换模型/去设置）」。
3. **致命/API/额度错误 escalate 成 banner**（不挂在某个工具 cell 下），如「额度不足 · 去充值」「429 限流 · 重试中 x/y」。
4. **修标签矛盾**：Bash 退出码语义修正，成功不显示「可能不可靠」。
5. **error 字段也 stripAnsi**（现仅 output 清了，error 没清，`ToolDetails.tsx:50-53`）。

## 6. MCP 渲染
- 每次调用 = 普通 tool cell：`server.tool(参数)`，running→done 原地，错误同 §5 cap 5 行。
- **server 连接/健康单独 surface**（连接中/pending/failed + 输出超额警告），不混进 transcript（对标 Codex spinner / Kimi 全局 modal / CC `/mcp` 面板）。

## 7. skill / subagent 渲染
- 折叠成**一个父 cell**，summary = 结果；子调用 **bounded**（显示最近 N + 「{n} more …」），身份/颜色标签（`subagent {type}({id})`）。
- workflow stage 错误**截断**（现全量，`ToolCallDisplay/index.tsx:361-364`），并入父 cell 的折叠详情。
- 完整子树放侧栏/可展开，不平铺进主轨。

## 8. live ↔ history 同源
- **持久化** `hook/skill/artifact/routing` 等 timeline 事件到 message metadata；history 加载时 `turnTimelineProjection.ts` 从 metadata 重建同样的 `turn_timeline` 节点 → 两态同源。
- 删 `MessageBubble/AssistantMessage` 死代码（确认无引用后）。

## 9. 借鉴清单（Neo 落点 + 成本 + 优先级）
| 借鉴点 | 来源 | Neo 落点 | 成本 | 优先级 |
|---|---|---|---|---|
| 失败=同 cell 红 glyph+一行+cap+展开，去重 | Codex F1 | `ToolDetails.tsx` / `ToolStepGroup.tsx` / `ToolCallDisplay/index.tsx`(去 loop chip 重复) | 中 | **P0** |
| humanize 扩展(429/401/超时/余额/超载) + error stripAnsi | CC API-error banner | `toolExecutionPresentation.ts` | 小 | **P0** |
| API/额度错误 escalate banner | Codex `new_error_event`/CC | 新 `notice-error` cell + ChatView | 中 | P0 |
| Bash 退出码标签修矛盾 | — | `statusLabels.ts:139-145` | 小 | P0 |
| 搜索聚合一致(统一组、禁混用) | Codex Exploring | `toolStepGrouping.ts` | 小 | P1 |
| reasoning 强制合并暗色一块 | Codex/Kimi/CC P5 | `TraceNodeRenderer.tsx:346-505` | 小 | P1 |
| hook 固定语义位 | — | `TurnCard.tsx` | 小 | P1 |
| timeline 事件持久化+history 重建 | — | `message.ts` metadata + `turnTimelineProjection.ts` | 中 | P2 |
| MCP server health 独立 surface | Codex/Kimi/CC | 新 MCP 状态组件 | 中 | P3 |
| subagent 折叠父 cell + bounded children | Kimi deque(4)/CC | `ToolCallDisplay/index.tsx`(workflow) | 中 | P3 |
| 删 MessageBubble 死代码 | — | `MessageBubble/` | 小 | P3 |

## 10. 分期（并入 2c）
- **P0 失败去噪**（噪音最痛、最快见效）：去重 + cap + humanize 扩展 + banner + 标签修。
- **P1 聚合一致**：搜索聚合 + reasoning 合并 + hook 归位。
- **P2 live/history 同源**：timeline 持久化 + 重建。
- **P3 MCP/subagent + 删死代码**。

每个 P 独立 PR、TDD（渲染纯函数+快照）、独立 context 对抗审计。
