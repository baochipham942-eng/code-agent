# 实施计划 · 设计画布节点连线 / freeform 图解

> 来源：设计能力借鉴路线外圈「节点连线 / freeform 图解」（见 `docs/plans/design-roadmap.md`）。
> 定位：Agent Neo = cowork 人机协作产品（产物为主轴、人主导直接操作）。这一刀把设计画布从"贴图墙"
> 升级为真正的**图解 / 用户流 / IA surface**——是后续「Agent 操作画布（人审批）」的前置地基。
> 拍板（2026-06-23，林晨）：① 连线 + freeform 形状**全做**；② 扩图/去水印成本补全**折进本刀**。
> 分支 `feat/design-diagram-canvas` / worktree `code-agent-diagram`，基于 origin/main `644a7dbb0`。

## 范围边界

**做**：
- **连线 connector**：节点↔节点的箭头，锚到 nodeId，节点移动时按两端几何自动重连（最近边锚点），
  可选文字 label（画用户流 / 流程步骤）。
- **freeform 形状 shape**：矩形 / 椭圆 / 文字 / 便签(sticky) / 自由线，作为**可落盘**的一等画布对象。
- 工具栏模式切换（select / connect / shape:*），拖拽创建、选中、删除、移动。
- 落盘进 `canvas.json` 新增 `connectors[]` / `shapes[]`（加法，无迁移）。
- 接入 ⑤ undo/redo 历史栈（图解编辑也可撤销）。
- **bolt-on**：扩图/去水印两个付费 handler 补 `costCny + actualModel` 返回 + renderer 记一笔成本。

**显式不做**（留下一刀）：
- **Agent 操作画布（人审批）**：本刀只给"人直接画图解"，agent 那半依赖本刀做完才有地基。
- 连线的复杂样式（曲线贝塞尔 / 多段折线 / 端口吸附点）——MVP 用直线 + 最近边锚点。

## 关键设计决策

### D1：数据模型加法，`CANVAS_DOC_VERSION` 维持 1（不迁移）
`deserializeCanvasDoc` 是**显式重建**（只读已知字段），新增可选数组缺失时自然降级为 `[]`，
老存档零破坏；老版本 app 读新档会丢图解层（加法语义可接受，单一代码库内无真实风险）。
- `CanvasConnector { id, fromNodeId, toNodeId, label?, createdAt }`——**不存几何**，渲染时按两端节点
  实时算锚点（节点移动自动跟随，无需回写）。两端任一节点被删/淘汰 → 连线渲染时过滤（悬空保护）。
- `CanvasShape` 判别联合：`rect | ellipse | text | sticky | line`，各带 `id/x/y/几何/color/createdAt`，
  text/sticky 带 `text`。形状是**自由浮动**（不锚节点）。
- `DesignCanvasDoc` 加 `connectors?: CanvasConnector[]` / `shapes?: CanvasShape[]`。

### D2：图解层独立于 variant spine
形状 / 连线是**图解脚手架**，不是生成产物，**不进版本时间线**（无 chosen/discarded/parentId 语义）。
它们与 nodes 平级存 canvas.json，但 `groupKey`/A/B 对比/成本累计一概不碰它们。

### D3：复用 reduceAnnot 纯归约器模式，但独立可落盘模型
`AnnotationLayer` 是临时红标注（喂 mask/重绘，不落盘）。本刀新建 `diagramReducer.ts`（纯函数，
照搬 reduceAnnot 的 down/move/up 归约 + 不可变更新模式）+ `DiagramLayer.tsx`（react-konva，
与 AnnotationLayer 平级挂 Stage）。两者职责不混。

### D4：接入 undo/redo（⑤）
画布编辑历史快照须扩到含 `connectors/shapes`，使"画一条线 / 删一个形状"可 Cmd/Ctrl+Z 撤销。
（落地时核对 ⑤ 的快照实现，确保图解 op 同样进栈。）

### D5：无新增 workspace IPC
图解层纯前端落盘，复用现有 canvas.json 写盘链路（`designCanvasPersistence`）。
→ **不碰 shellCapabilities.ts**，无 renderer-capability-diff 风险。

## 实现路径（TDD 优先）

### Phase 1 · 纯逻辑（先写测）
1. **数据模型 + 序列化**：扩 `designCanvasTypes.ts` 加 connector/shape 类型 + normalize + serialize/deserialize 往返。
   测：老档无字段→`[]`、破损节点过滤、往返幂等、负数/非法几何拒绝。
2. **diagramReducer.ts**：形状 down/move/up 归约（rect/ellipse/line 拖拽；text/sticky 立即落定）。
   测：照搬 annotationLayer.test 结构。
3. **连线锚点几何 `connectorGeometry.ts`**：给两端节点 box → 算最近边锚点 + 箭头端点。
   测：四象限相对位置、重叠、零尺寸保护。

### Phase 2 · store（TDD）
4. `designCanvasStore` 加 `connectors/shapes` 状态 + `addConnector/deleteConnector/addShape/updateShape/deleteShape`；
   `toDoc/loadDoc` 带上；删节点时级联保护悬空连线（渲染层过滤，store 不强制删）。
5. undo 快照扩展（D4）。

### Phase 3 · UI（typecheck + Playwright）
6. `DiagramLayer.tsx`（react-konva 渲染形状 + 连线 + label）。
7. 工具栏模式切换（select/connect/shape:*）+ i18n（zh/en 对齐）。
8. connect 交互：点源节点 → 点目标节点 → 建连线。

### Phase 4 · bolt-on 成本补全
9. `handleExpandDesignImage` / `handleRemoveWatermarkDesignImage` 返回扩到
   `{ path, actualModel, costCny }`（复用 `estimateImageCostCny` + wanx 模型常量）；
   renderer 回灌时把 costCny 挂上节点 / 记一笔。测：返回契约 + 成本非负。

## 验证 & 收尾
- TDD 纯逻辑单测全绿 → `npm run typecheck` 净 → Playwright 真机（`__neo*` 钩子 + 独立 chrome-headless，
  不抢系统 Chrome）→ 独立 context skeptic 子 agent 当反方审计，修 HIGH/MED →
  PR → CI 全绿 → 等林晨点头合 → 更新 `docs/plans/design-roadmap.md` 进度日志。

## 风险 & 守门
- **悬空连线**：节点删除后连线两端失效 → 渲染层过滤 + 反序列化时丢弃指向不存在节点的连线。
- **坐标系一致性**：DiagramLayer 必须与现有节点层共用同一相机变换（`getRelativePointerPosition`），
  否则形状/连线与图片错位（照 AnnotationLayer 的 worldPoint 实现）。
- **i18n 漏键**：新工具栏文案 zh/en 必须同步（en.ts 推导 Translations 类型）。
- **god-file**：`workspace.ipc.ts` ~1400 行——bolt-on 只改两个既有 handler 返回值，不新增 handler，不加重。
