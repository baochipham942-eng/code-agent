# 会话区状态语义乱象 — 根因排查（5 路并行 Explore 汇总）

> 来源：2026-06-15 dogfood「把我的龙虾升级」一轮，用户一眼挑出 5 类乱象。
> 5 个 Explore agent 各挖一条线 + 主线交叉验证。**核心发现：现象 1/2/3 是同一个 villain 的连锁反应。**

## 一句话总判
**一个"良性内部重试"被当成失败到处放火。** 工具未加载→自动加载→让模型重试，本是正常自愈，但它合成的 `success:false` 伪结果污染了渲染、状态计数、决策 chip 三处。修这一个源头，现象 1/2/3 大半同时消失。

---

## 🔴 Villain：auto-load 伪失败（连锁引发现象 1+2+3）

**源头**：`src/main/agent/runtime/messageProcessorUnavailableTools.ts:95-127`（graceful deferred-tool 自愈分支）

模型调用了尚未解锁的 deferred 工具（如 WebFetch）时：
1. 自动加载该工具，注入 system 提示让模型重试（:72-79）——**这步是对的**
2. 但给**每个 toolCall 合成一条 `success:false` 的 `recoveryResults`**（:95-106），error 文案 = "Tool X was not loaded yet and has now been auto-loaded. Call it again."
3. 打包成 `role:'tool'` 消息（content = `JSON.stringify(recoveryResults)`，:107-113）持久化 + 作为 `message` 事件发到 UI（:115）
4. 又把这些 `success:false` 结果作为 `tool_call_end` 事件灌给工具节点（:116-125）

这个 `success:false` 顺着三条路放火：

| 现象 | 渲染/判定点 | 根因 |
|------|------------|------|
| **① 裸 JSON `[{"toolCallId"...success:false...}]` 糊在正文** | role:'tool' 消息内容（:110）被某条渲染路径打印 | 该伪结果本不该作为可见消息发出；render 路径待最终确认（projection :219 / MessageBubble :232 本应过滤 role:'tool'，仍漏出——大概率经 tool 节点 error 输出或 message 事件旁路）|
| **③ "1 failed, 1 completed" 自相矛盾** | `ToolStepGroup.tsx:258` `summarizeToolGroupResults`：`result.success===false → failed++` | auto-load 伪失败算进 failed，重试成功算 completed，同一组同时两个计数 |
| **③ 状态卡 "running" 不收尾** | `ToolStepGroup.tsx:285` `getToolGroupStatusLabel`：streaming→"running" | 伪失败的工具节点未拿到正常终态，组状态 stuck streaming |
| **②④ 红色「暂停恢复」chip** | `toolExecutionPresentation.ts:100-108` `summarizeToolLoopDecision`：任意 `success===false` → action「暂停恢复」tone error | auto-load 伪失败触发 error 决策，渲染于 `ToolStepGroup.tsx:313-327 LoopDecisionRow` |

**修法（源头优先）**：给 auto-load 恢复结果打上明确标记（已有 `metadata.autoLoadedTools`，可加显式 `autoLoaded:true`），UI 三处消费方据此**不当失败**：
- 不计入 `summarizeToolGroupResults` 的 failed（视为良性/重试中）
- 不触发 `summarizeToolLoopDecision` 的「暂停恢复」error 决策
- 工具节点渲染为中性「已自动加载·重试中」而非红色 error
- role:'tool' 伪消息不作为可见 `message` 事件发出（模型上下文仍保留）

> 注：现象①的精确渲染路径（为何 role:'tool' 仍漏出 JSON）未 100% 锁死，但源头打标 + 不发可见 message 事件可消除，实现时再验证落点。

---

## 现象② 残留：「暂停恢复」等工程师黑话（即便真失败也看不懂）

**位置**（3 处渲染）：
- `ToolStepGroup.tsx:313-327` `LoopDecisionRow` — 截图里的红 chip（action + reason + expectedNextAction）
- `ToolCallDisplay/index.tsx:408-432` — `getToolRecoveryHint` 灰字提示
- `TaskPanel/RunWorkbenchCards.tsx:452-476` — 时间线里同一套决策

**需翻成人话的字符串**（`toolExecutionPresentation.ts`）：

| 现文案 | 触发 | 改 |
|--------|------|-----|
| 暂停恢复 | 任意 success===false | "有工具报错"/真失败才显，且说清楚 |
| 等待工具返回 / 收到结果后继续汇总或执行下一步 | pending | 口语化或直接省 |
| 完成 N 个工具调用 / 工具结果已返回 / 把结果并入回复或继续下一步 | 成功 | 成功态本就不渲染（:315 已 return null），冗余 |
| 查看错误输出，必要时换工具或重试 | error | "可重试或换个工具" |
| 查看输出后重试或换工具 / 产物已记录 / 结果已记录 | recovery hint | 口语化或省 |

---

## 现象③ 残留：英文 "running" / "Searched" 与中文混排
- 组摘要动词来自 `toolStepGrouping.ts:33-34`（WebSearch/WebFetch → verb 'Searched'）、状态来自 `ToolStepGroup.tsx:284-289`（streaming→"running"）——刻意的 Claude-Code 风格英文。
- 真正的 bug 是**状态不收尾**（见 villain），不是英文本身。修 villain 后组能正常翻 completed。可顺手把 "running" 状态标签也中文化保持一致。

---

## 现象④：右侧 TaskPanel 信息架构混乱（独立问题）

**组件树**：`TaskPanel/index.tsx` → `TaskMonitor.tsx` →（顶部进度卡 + 任务/子代理/待审/产物/上下文/MCP 多个 Card）

| 吐槽 | 根因 file:line | 修法 |
|------|---------------|------|
| 标题="执行 Bash"（=工具名，没信息量）| `runWorkbenchProjection.ts:622-634` `taskProgressTitle`：无 step 时降级到 `工具 ${tool}`；优先级里 tool 太靠前 | 标题优先级改为 planTitle → sessionTask.subject → step → （工具名垫底）|
| 进度 `0/1·0%` 运行中永远 0% | `TaskMonitor.tsx:172-176`：只数 `steps[].status==='completed'`，**完全无视 `TaskProgressData.progress`(0-100)** | 运行中且有细粒度 progress 时改显 `progress%`，否则显 steps 完成度 |
| 顶部卡 + "任务 1" 都写"执行 Bash"重复 | 两处都读 `TaskRecord.title`（`TaskMonitor.tsx:193` / `RunWorkbenchCards.tsx:297`）| 顶部管"宏观计划进度"、Card 管"任务明细"，去重 |

风险：TaskPanel 是 sidecar 深控面，改动面较大，独立做。

---

## 现象⑤：thinking 块堆叠（独立问题）

**根因**：不是模型切分，是**投影层把整份 thinking 复制到每个文本节点**。
- `useTurnProjection.ts:325-349` `pushAssistantTextNode`：`thinking: msg.thinking` 无条件赋给每个 assistant_text 节点
- 一轮 `thinking→tool→thinking→tool→text` 投影出 N 个 assistant_text 节点，**每个都带同一份 thinking** → 渲染成 N 个 `▶ thinking`（`TraceNodeRenderer.tsx:474-505` + `AssistantMessage.tsx:214-247` 各一处折叠）

**修法（低风险）**：投影层只给**首个** assistant_text 节点挂 thinking，后续节点不挂（`useTurnProjection.ts` `pushAssistantTextNode` 加 `hasAttachedThinking` 闭包标记）。

---

## 实施 backlog（建议顺序，风险递增）

1. **🔴 灭 villain**（issues 1+2+3 大半）：auto-load 恢复结果打标 + UI 三处消费方不当失败 + 伪消息不发可见 message。**碰 agent runtime + 3 个渲染消费方，最高杠杆但风险最高，重点测多 agent/deferred-tool 重试别回归。**
2. **黑话翻人话**（issue 2 残留）：纯文案，`toolExecutionPresentation.ts` + 3 渲染点。低风险。
3. **thinking 投影收敛**（issue 5）：`useTurnProjection.ts` 一处。低风险，已有单测点可补。
4. **"running" 状态中文化**（issue 3 残留）：`ToolStepGroup.tsx:284-289`。低风险。
5. **TaskPanel 信息架构**（issue 4）：标题优先级 + 进度绑 TaskProgressData + 去重。中风险、面较大，独立提交。

> 全程只读分析得出，file:line 基于 2026-06-15 当时代码。动手前先核对行号未漂移。
