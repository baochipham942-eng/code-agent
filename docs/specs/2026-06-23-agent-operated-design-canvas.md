# 2026-06-23 Agent 操作设计画布（人审批）Spec

> **状态**：as-built，已全部合 main。
> **时间窗**：2026-06-23 CST
> **证据范围**：ADR `194bbfe3b`（采纳，PR #276）→ 一刀 `fc8229938..2751ba086`（PR #277，merge `f686c4b2`）→ 三刀+二刀 `1d7dc5c9a..8533fd776`（PR #278，merge `40fe9ac31`）
> **关联**：决策 [ADR-026](../decisions/026-agent-operated-design-canvas.md)（含二刀增补）；架构 [design-mode.md §5.15](../architecture/design-mode.md)；产品总览 [design-mode-spec.md](../designs/design-mode-spec.md)；路线锚 [design-roadmap.md](../plans/design-roadmap.md)
> **审计**：[2026-06-23-ee7a93c44-design-cut2-paid-generation.md](../audits/2026-06-23-ee7a93c44-design-cut2-paid-generation.md)（二刀 4 轮对抗审计收敛）

把设计画布从「用户直接操作 + AI 直连出图」扩成「**AI 也能提议改画布，人点头后由 renderer 落地**」。核心立场不变——**agent 只提议、不直接落地**，真正改 store 的永远是 renderer（守「人主导直接操作」）。Main 进程永不直接 mutate 画布。本批分三刀交付：一刀（只读提议闭环，无付费）、三刀（per-op 取舍 + 软删可恢复）、二刀（含付费生成提议，付费前置审批）。

## 产品契约（Product Contract）

| 领域 | 契约 |
|------|------|
| 提议而非直改 | agent 在设计画布用 `ProposeCanvasOps` 工具提议一批操作并**阻塞等用户审批**；agent 永不直接改画布，用户在画布上看到 ghost 预览后点 Apply/Reject。 |
| op 白名单 | 允许：`moveNode`（排布）/`addConnector`（连线）/`addShape`（形状/标注）/`renameNode`（改标签）/`discardNode`（软删，可恢复）/`generateImage`（文生图，付费）。**硬删 `deleteNode` 永不开放给 agent**。 |
| 逐项取舍 | 审批条逐 op 勾选，用户可只应用子集；取消勾选的 op 回报给 agent 计入「已跳过」，避免 agent 反复重提被否决项。 |
| 软删可恢复 | `discardNode` 是非破坏软删（节点留盘、不进 Cmd+Z），从画布「已淘汰 N·恢复」托盘找回；与人类淘汰行为一致。 |
| 付费前置审批 | 含付费生成（`generateImage`）的提议，**预估 ¥ 在用户 Apply 前显示**（renderer 查价表算，不信 agent 报价）；审批面板即付费闸——阻塞工具等待期间零付费调用，用户点 Apply 后才真出图。拒绝/超时零花费。 |
| 成本诚实 | 审批面板显示的预估 ¥ 与实际出图账单一致（dogfood 实锤 wanx 文生图预估 0.14 == 实际 0.14）；取消勾选某张生成，合计 ¥ 实时只算选中项。 |
| 模型边界 | agent 提议的生成模型仅当是已配置的内置 t2i 模型才采纳，否则回退用户表单默认——**agent 不得引入新模型/端点**。生成图落位由 renderer 自动定，忽略 agent 建议坐标。 |
| 撤销语义 | 纯 Layer1 批（移动/连线/形状/标注）= 一个原子撤销单元，一次 Cmd+Z 撤完；含生成的批，生成产物经 variant spine 非破坏管理，「撤掉这次生成」= 在历史/淘汰里找回，不靠 Layer1 undo。 |
| 落地隔离 | agent abort / 审批超时后，画布审批条自动撤掉，避免「孤儿提议」被用户事后误点 Apply 触发付费生成；用户已点 Apply 进入落地的提议则照常完成。 |
| 降级 | 无交互式画布环境（CLI/headless）下 `ProposeCanvasOps` 不假装已应用，明确回告 agent「请改用文字描述建议」。 |

## 三刀范围

### 一刀 · 只读提议闭环（Layer1，无付费）
- 提议引擎地基（自包含 op 契约 + stale-target 防御 + 整批原子撤销）+ `ProposeCanvasOps` 阻塞工具 + `CANVAS_PROPOSAL_ASK/RESPONSE` IPC + 每轮画布快照上下文注入（agent 据此引用真实节点 id）+ Konva ghost 预览 + 审批条。

### 三刀 · per-op 取舍 + 软删可恢复
- 审批条逐 op 勾选；`discardNode` 软删（Layer2 非破坏）+ `restoreNode` + 「已淘汰·恢复」托盘，补上画布软删本缺的找回路径（人类也受益）。

### 二刀 · 含付费生成提议
- `generateImage` op（文生图，唯一付费 op）；应用走**双相**：Phase A 同步 Layer1（一次快照）→ discard → Phase B 串行付费出图 → 收尾按生成成败清编辑历史。付费前置审批 + 成本透明 UI + 跨边界并发锁（按 requestId）。MVP 只给文生图，agent 提议的编辑/扩图/视频等衍生付费 op 暂不开放。

## 验证

- 405 单测绿 + `npm run typecheck` 净；capability/ipc/shared 门绿。
- 一刀/三刀各经独立 skeptic 对抗审计修 HIGH/MED；二刀经 **4 轮对抗审计收敛**（独立反方，Codex exec 截断 fallback Gemini/antigravity），修 3 HIGH + 6 MED + 3 LOW（详见审计报告）。
- 一刀/三刀真机 headless E2E（提议→ghost→应用/取消勾选/淘汰恢复，零相关错误）。
- 二刀**真 key 付费 dogfood ✅**（¥0.14 一次）：真 wanx 返回 `actualModel=wanx2.1-t2i-turbo / costCny=0.14`，实际成本 == 审批面板预估。

## 未覆盖 / 后续

- agent 不知**具体哪条** op 被否（仅回聚合计数）——三刀既定计数口径，后续若需扩 `CanvasProposalDecision` 带 skipped op 身份。
- agent 提议**编辑/扩图/去水印/视频**等衍生付费 op（要绑底图 + 更多参数 + 更贵）——单独后续刀，每条破坏性/高价 op 单独硬审批。
