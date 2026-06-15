# 会话区 UX 杂乱排查 — 交接文档（给新会话）

> 来源：2026-06-15 三个并行 agent 从内容/样式/反馈三个 lens 审会话区。
> 核心问题：会话区是否便于用户**专注 vibe coding + 给模型反馈**，还是被噪音分散。
> 新会话建议：用 `/design` skill，按本文 backlog 逐条做减法。**不用重跑那 3 个 agent。**

## 渲染链路
`ChatView.tsx` → `TurnBasedTraceView.tsx` → `TurnCard.tsx` → `TraceNodeRenderer.tsx`（节点真正渲染器）。
过去两天新增的 "surface X" 内容几乎全注入在 `TraceNodeRenderer` 的 assistant 节点上方 + `TurnCard` 的 turn 级横幅。

## 一句话总判
**偏噪音、偏杂乱、反馈链埋没。** 正文与代码 diff（真正的主角）被一圈彩色 surface chip 挤成视觉配角；单轮高密度下正文被 15–25 个视觉块、8–12 个彩色 border+bg chip 包围。团队**已有正确范式**（`capability_scope`/`workbench_snapshot` 已 `return null` 下放面板；`ToolHeader` 无 border/bg 最克制），但新加的 quality/route/hook/skill 横幅没遵守，焊死在对话流里。

---

## Lens 1 — 内容信噪：主会话流不该常驻的 Top 噪音

| # | 元素 | file:line | 默认 | 建议 |
|---|------|-----------|------|------|
| 1 | **TurnQualityStrip 评分条**（`47/100`+记忆数+策略+agent+工具数，5 个彩 chip） | `TraceNodeRenderer.tsx:470-472` / `TurnQualityStrip.tsx:138-173` | **常驻**，无开关 | eval/调试内幕，下放面板或默认折叠；折叠态最多留 1 个语义色评分 |
| 2 | **RouteTraceChip 路由决策 chip**（reason 标签 + modelA→modelB） | `TraceNodeRenderer.tsx:461-468` / `RouteTraceChip.tsx:386-432` | **常驻** | 路由内幕，用户不需要；收进 hover/详情 |
| 3 | **Hook 执行横幅**（"执行了 N 个钩子·全局·仅观察"） | `TurnCard.tsx:346-427` / `TraceNodeRenderer.tsx:734-793` | **常驻** | 引擎内幕，默认折叠或并入工具流 |
| 4 | **Skill 活动横幅**（默认 `expanded=true`，比 hook 更吵） | `TurnCard.tsx:447-484` | **常驻展开** | 至少默认折叠 |
| 5 | routing_evidence 节点（路由步骤+状态点） | `TraceNodeRenderer.tsx:682-717` | 常驻 | 调试证据，下放 |
| 次 | 用户气泡里的 WorkbenchSummary pills（工作目录/路由模式/目标 agent/skill/MCP…） | `TraceNodeRenderer.tsx:152-209` | 常驻 | 内幕配置态，弱化 |

**对照组（做对了，当模板）**：`capability_scope`/`workbench_snapshot` 已 `return null`（`TraceNodeRenderer.tsx:95-100`）；ReplayAuditPanel 收在 App 级面板；模型策略推荐/能力建议收在 composer 输入区。

---

## Lens 2 — 视觉层级/样式问题

违反的核心原则：**一屏 ONE 主焦点、中性色承载内容/饱和色只给交互、留白优于边框**。

### Critical
| 问题 | file:line | 修法 |
|------|-----------|------|
| 流式代码块跨 25 行瞬间自动折叠、无动画、阅读中塌陷 | `MessageContent.tsx:391-393` | 只在初次 mount 折叠（`useState(()=>isLong)`），删该 effect；或仅非流式态折叠 |
| DiffView 每行 `content-visibility:auto` + 固定 `containIntrinsicSize:20px`，长行滚动进视口高度跳变 | `DiffView.tsx:26-29`（用于 :266/:275） | 提高 intrinsic 估值/允许换行测量，保证行高稳定 |
| TurnQualityStrip 一行 5 个平级彩 chip（emerald/amber/sky/fuchsia/zinc）抢注意力 | `TurnQualityStrip.tsx:149-172` | 折叠态只留 1 个评分 chip，其余降中性灰或进展开面板 |
| RouteTraceChip 单 chip 覆盖 6 种饱和色 | `RouteTraceChip.tsx:416`（getToneClass） | 收敛 2 档：正常=中性灰、异常=单一警示色 |

### Warning
- 大量 `h-px`/`w-px` 线条分隔而非留白（`TurnCard.tsx:156`、`AgentStatsBar.tsx:143/157/165`、`TaskStatusBar.tsx:189/238`）→ 改 gap/space-y。
- 嵌套 chip（chip 里套 chip）：`ModelStrategyRecommendationStrip.tsx:18-37`、`TurnCard:631-645` → 内层降纯文本。
- 每个 chip 都 border+bg 双描边 → 二选一。
- 元数据（feedback👍👎 + token badge + quality strip）堆在正文尾抢权重 → hover 才显或合并极淡 meta footer。
- 字号 4 档混用（`text-xs`/`[11px]`/`[10px]`/`2xs`）→ 收敛 2–3 档。
- `text-[10px]` 元数据对比度存疑（`text-zinc-600`、`amber-300/65`）→ 提亮到 zinc-400+。

**正面模板**：`ToolHeader.tsx` 无 border/bg、靠 StatusIndicator 表达状态 —— 作为 chip 区重构目标范式。

---

## Lens 3 — 给模型反馈的交互链（埋没+带坑）

vibe coding 最高频的"这条不行，重来/改"三个动作全埋没：

| 动作 | file:line | 问题 |
|------|-----------|------|
| 停止生成 | `SendButton.tsx:76-87` + Esc(`useKeyboardShortcuts.ts:259`) | ✅ 顺，常驻 |
| 点赞/点踩 | `AssistantMessage.tsx:281-312` | ⚠️ 常驻但**只对纯文本回答出现**（`canSubmitFeedback` 要求 `!hasToolExecutionContent`，:41-46）——带工具调用的回答（绝大多数）看不到 |
| **regenerate / fork / 编辑** | `AssistantMessage.tsx:158-201`、`UserMessage.tsx:71-80` | 🔴 **全靠 hover 才现身、无快捷键**；`session.retry` 在 keybinding 表里但 `useKeyboardShortcuts.ts:437-438` 直接 `return false` **未接线** |
| 编辑上一条 | `messageActionStore.ts:52-56` | 🔴 **假编辑**——只把新内容当新消息 `_send`，不替换原消息/不截断后续，模型上下文双份 |
| 生成中纠偏 | `ChatInput/index.tsx:1082` supplement | ⚠️ 是"排队到下一轮"不是立即打断 steering |
| 裸键 `/` 吞字符 | （T2） | ✅ **本次已修**（commit `4ef4b957f`，焦点门控+不覆盖文本） |

**建议优先级**：① regenerate/编辑/fork 给常驻入口或快捷键（接线 `session.retry`）；② 点踩对带工具回答也可见；③ 修"假编辑"语义（真替换+截断）。

---

## 建议的减法 backlog（新会话按此做）
1. **降噪优先**：TurnQualityStrip + RouteTraceChip + hook/skill 横幅 → 默认折叠/下放面板（比照 `capability_scope` 的 `return null` 范式）。
2. **去 layout shift**：流式代码块自动折叠塌陷 + DiffView 行高跳变两个 Critical。
3. **反馈链**：regenerate/编辑/fork 常驻化 + 接线快捷键 + 修假编辑。
4. **颜色/留白减法**：彩色 chip 收敛中性色、border→留白、字号收敛。

> 全程只读分析得出，file:line 基于 2026-06-15 当时代码，新会话动手前先核对行号未漂移。
