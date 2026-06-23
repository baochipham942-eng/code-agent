# ADR-026: Agent 操作设计画布（人审批）

- **状态**: 已采纳 — **D1-B + D2-A + D3-B + MVP 范围（加/排布/连线/标注，不给删除）**（2026-06-23 林晨拍板：「按推荐全要」）
- **日期**: 2026-06-23
- **关联**: 设计能力借鉴路线（`docs/plans/design-roadmap.md`）外圈最后一项；依赖已合 main 的节点连线/freeform 图解（PR #274）与画布编辑历史（PR #267）
- **定位铁律**: Agent Neo = cowork 人机协作产品（产物为主轴、对标 Manus），**不是编程 agent**。设计画布是产物 surface 之一，**人主导直接操作、AI 辅助**。

## 背景

现状（三路实地探查复核）：

1. **画布出图"直连不经 agent"**：用户生成设计图时，renderer 直接调 `WORKSPACE/generateDesignImage` IPC（`useDesignCanvasGeneration.ts`），**不走 main 的 agent loop**。画布 store（`designCanvasStore.ts`，Zustand）**只活在 renderer**，main 进程的 agent 看不见画布状态。
2. **主→渲染推送通道已存在但画布未接**：tool 可 `ctx.emit(event, payload)` → `toolExecutionEngine` 包成 AgentEvent → `createAgentRuntime` EventBatcher → `mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT)` → renderer `ipcService.on('agent:event')` 订阅（`taskCreate` 的 `task_update` 是先例）。但 **AgentEvent union 无画布类型、renderer 无画布监听器**。
3. **现成的"阻塞式问人"原语**：`askUserQuestion`（tool 发 `USER_QUESTION_ASK` IPC → Promise 阻塞等 `USER_QUESTION_RESPONSE`，靠 `requestId` 关联 + 超时回退）。这是唯一现成的「agent 提议 → 阻塞 → 拿结构化决定 → 恢复」闭环。`exit_plan_mode` 是注入合成消息式恢复，per-op 结构化弱。
4. **画布编辑历史有致命不变量**：加 Layer2 节点（生成产物）后**必须 `clearEditHistory()`**，否则跨生成 undo 会还原到不含新节点的旧数组 = 静默删掉刚加的节点（PR #274 skeptic 打过这仗）。undo/redo 经 `reconcile*Frame` 调和（保 Layer2 chosen/discarded、还原 Layer1 几何）。
5. **持久化**：`saveCanvasDoc` = 即时 IPC writeFile 到 `canvas.json`，无防抖；现仅生成成功触发存盘。

**核心立场**：守"人主导直接操作"。**Agent 只提议、不直接落地**——真正改 store 的永远是 renderer（经现有 store actions，天然尊重历史/variant spine 不变量）。这一刀把"出图直连不经 agent"扩展为"agent 能读画布 + 提议 op，人点头后由 renderer 应用"。Main 进程**永不**直接 mutate 画布。

## 决策

### D1 — 跨进程画布状态桥（agent 怎么"看见"画布）= **B：每轮注入画布快照**

进设计模式时，renderer 把当前 `store.toDoc()`（节点 + 连线 + 形状 + camera）**注入 agent 上下文**（随 turn 上下文带下去）。agent 永远看到用户眼前的最新态，无需"读画布"工具或跨进程读状态机制。

- 否决 **D1-A 读 canvas.json**：会读到陈旧态——用户拖动/改名不落盘（现仅生成才存），agent 看到的不是屏上真相。
- 否决 **D1-C 请求/响应桥**：最准但要新建 main→renderer→main 往返，最重，价值不抵成本。

**落点**：与"出图直连"对称——画布态从 renderer 侧权威源经上下文注入流向 agent，不引入跨进程读状态新机制。注入内容须**限长/裁剪**（大画布只带结构摘要 + 选中区，防 prompt 膨胀）。

### D2 — 人审批协议（怎么提议 + 怎么点头）= **A：askUserQuestion 式阻塞工具 + ghost 预览 UI**

新工具 `proposeCanvasOps`：agent 发结构化提议（op 列表）→ **阻塞等审批响应**（应用 / 拒绝 / 改）→ 结果回 agent。renderer 用**幽灵预览**（ghost 节点 / 连线虚影 / 标注叠层）把"agent 想怎么改"画在画布上，配 Apply / Reject。

- 否决 **D2-B plan-mode 式**：适合粗粒度整批，但无 per-op 结构化决定、预览弱。
- 否决 **D2-C 权限闸 canUseTool**：只有"准/不准"，没有富预览，不适合"先看提议长啥样再决定"。

**落点**：复用 `askUserQuestion` 的阻塞往返骨架（新 IPC channel `CANVAS_PROPOSAL_ASK` / `CANVAS_PROPOSAL_RESPONSE` + `requestId` 关联 + 超时）；新建 ghost-preview UI 层（在 Konva 上叠提议虚影，不进 store）。审批不是 yes/no，是「先在画布上看到 agent 想怎么改，再点应用」。

#### 提议数据模型（草案）
```ts
interface CanvasOpProposal {
  requestId: string;
  ops: CanvasOp[];          // 一批提议
  rationale?: string;       // agent 为何这么改（一句话给用户看）
  estCostCny?: number;      // 若含付费生成，预估花费（付费前置审批，见红线①）
}
type CanvasOp =
  | { kind: 'addNode'; node: ProposedNode }       // 加（含/不含付费生成）
  | { kind: 'moveNode'; id: string; x: number; y: number }   // 排布
  | { kind: 'addConnector'; connector: ProposedConnector }   // 连线
  | { kind: 'addShape'; shape: ProposedShape }               // 形状/标注
  | { kind: 'annotate'; targetId: string; text: string };    // 标注
// MVP 不含 deleteNode / discardNode（破坏性，见红线②）
interface CanvasProposalDecision {
  requestId: string;
  verdict: 'apply' | 'reject';
  appliedOpIds?: string[];  // 预留 per-op 取舍（首版可整批 apply）
  feedback?: string;        // verdict=reject 时回 agent 的修改意见
}
```

### D3 — op ↔ 编辑历史落地 = **B：整批 = 一个原子撤销单元 + 混批顺序写死**

提议批准后由 renderer 经现有 store actions 应用。历史整合规则（这一刀最易爆雷处，#274 的 reconcile 坑就在此）：

- **纯 Layer1 批次**（移动/改名/连线/形状/标注）：应用前**快照一次**，整批一次 undo 撤完。
- **含 Layer2 加节点的批次**：走生成语义——**先应用 Layer1 op（快照内）→ 再应用 Layer2 加节点 → 应用毕 `clearEditHistory()`**。整批不可 Layer1 undo，但**非破坏**："撤销"= discard 新增变体，靠 variant spine 兜底。
- **混批顺序写死成硬规则**（Layer1 先于 Layer2），否则重蹈"跨生成 undo 删节点"。

- 否决 **D3-A 每 op 等同用户操作**：最简单，但多 op 提议要按 N 次 undo 才能全撤，"撤掉 agent 这次改动"体验差。

**落点**：包一层 `applyProposalBatch(ops)`——内部按 Layer1→Layer2 排序、Layer1 整批单次快照、Layer2 后 `saveCanvasDoc` + `clearEditHistory`。复用现有 store actions，绝不另写一套 mutate 路径。

### 横切红线（写死，不单列决策）

1. **付费前置审批**：若提议含付费生成（出图/视频），审批**必须在付费之前**（沿用 region-lock 那刀"付费前拦截"哲学，不白烧钱）。`proposeCanvasOps` 阻塞期间不得发起任何付费调用；用户 apply 后才由 renderer 走既有付费生成 IPC。
2. **MVP op 范围**：首版 agent 只提议 **加 / 排布 / 连线 / 标注**；**删除 / discard 等破坏性 op 暂不给 agent**（后续若需，每条单独硬审批）。降风险、守"人主导"。
3. **Main 永不直接 mutate 画布**：agent 端只产出提议数据 + 经 IPC 阻塞等决定；一切 store 变更在 renderer 经现有 actions 落地。

## 后果

### 正面
- 守住"人主导直接操作"：agent 提议、人点头、renderer 落地，三权分立。
- 零新画布 mutate 路径：复用现有 store actions + variant spine + 编辑历史，不绕过既有不变量。
- 复用 `askUserQuestion` 阻塞原语 + 现有 AgentEvent 推送通道，新增面收敛在「画布提议事件类型 + ghost 预览 UI + 一个 propose 工具 + 一个 applyProposalBatch」。

### 代价 / 风险
- **ghost 预览 UI 是新建面**（Konva 叠层渲染提议虚影），需真机 E2E。
- **上下文注入裁剪**：大画布全量注入会撑爆 prompt，须定结构摘要策略。
- **混批历史顺序**是已知雷区，须 TDD 锁死 Layer1→Layer2 顺序 + clearEditHistory 时机（对抗审计重点盯这里）。
- 跨进程时序：阻塞期间用户手动改画布 / 切 run，提议可能基于陈旧态——apply 前须校验 op 目标节点仍存在（stale-target 防御）。

## 实施切分（建议，待逐刀推进）

1. **第一刀 · 只读提议闭环**：上下文注入（D1-B，含裁剪）+ `proposeCanvasOps` 阻塞工具（D2-A 骨架，复用 askUserQuestion 往返）+ ghost 预览 UI + `applyProposalBatch`（D3-B，先支持 Layer1-only：移动/连线/形状/标注，**不含付费生成**）。纯逻辑 TDD（applyProposalBatch 历史顺序 + stale-target 防御）+ 真机 E2E（提议→预览→apply/reject）。
2. **第二刀 · 含生成提议**：加 `addNode` 含付费生成的提议（红线① 付费前置审批）+ Layer2 混批历史（D3-B 完整）。
3. **第三刀（按需）**：per-op 取舍（appliedOpIds）/ 破坏性 op 单独硬审批。

> 每刀照设计能力借鉴路线工作纪律：origin/main 独立 worktree、TDD、独立 context 对抗审计修 HIGH/MED、PR 等 CI 全绿不擅自合、更新 roadmap 进度日志。

---

## 增补（二刀 · 含付费生成提议）

- **状态**: 已采纳 — **增补-D1-A + 增补-D2 写死 + 增补-D3 renderer 权威 + 二刀红线全收**（2026-06-23 林晨拍板：「按推荐全要」）
- **背景**: 一刀（Layer1-only 提议闭环）+ 三刀（per-op 取舍 + discardNode 软删）已落地（`feat/agent-canvas-cut3`）。二刀补上**唯一缺口**：agent 提议「生成新图」这类**含付费生成**的 op。原 ADR 已把横切红线①（付费前置审批）/ D3-B（混批顺序写死）写过，但当时只是声明；真要实现 `addNode 含付费生成`，有三处必须先把规则钉死再动手——本增补拍这三刀。
- **现状勘误（实地复核三处接口）**：
  1. 现有 `applyProposalBatch` 走 `computeProposalResult`（纯同步函数）+ `applyProposal` 控制器（已是 async 壳但内部全同步）。**生成是 async**（`generateDesignImage` IPC + 落盘 + 量尺寸全 await），同步引擎装不下。
  2. 现成付费链路在 `useDesignCanvasGeneration.generate()`，但它从 `useDesignStore` 表单读 prompt，**不接受外部 prompt 参数**——agent 提议需要一个「按显式 prompt 出图」的入口，要从 `generate()` 抽核。
  3. 付费前置审批已有先例：`generateVideo()` 用 `window.confirm` 在付费前显示预估 ¥。成本估算权威源 `estimateImageCostCny(model)`（查 `pricing.ts` 唯一真源，wanx 0.14/张），**在 renderer 侧**。

### 增补-D1 — applyProposalBatch 异步化 = **A：双相切分（Layer1 同步纯 + Layer2 异步生成），整体 await 到落地**

把 apply 切成两相，控制器变真异步：

- **Phase A（Layer1，同步纯，快照内）**：`computeProposalResult` **零改动**——move/connector/shape/rename 仍走现有同步引擎，一次快照、一次 undo。discardNode 仍按三刀（不进撤销批）。
- **Phase B（Layer2，异步生成）**：对每个生成 op **串行** await 付费 IPC → 成功则 `addNode` + `saveCanvasDoc` → 全部生成完毕后**统一一次** `clearEditHistory()`（见增补-D2 的 #274 不变量）。
- **新增 `generateImage` op 的核**：从 `generate()` 抽 `generateFromPrompt(prompt, {model?, aspectRatio?})` 纯函数式入口，`generate()` 与新提议路径共用，**绝不另写一套出图/落盘路径**（沿用「零新 mutate 路径」铁律）。

**关键子决策 · 阻塞工具何时 resolve = await 到生成落地（拿真实结果），不提前返回**：
- 理由：agent 该拿到**地面真相**——实际生成几张、实际花了多少 ¥、哪张失败。提前返回「已开始生成」会让 agent 在画布 mid-generation 时盲目追加提议。
- 超时处理：含生成的批次，main 侧把阻塞超时从 `USER_QUESTION`(300s) 抬到 `USER_QUESTION + 单图预算 × 生成数`（覆盖「用户思考 + 串行出图」总耗时），避免慢付费撞死工具。纯 Layer1 批次仍用 300s。
- 否决 **B 提前 resolve + 下一轮快照回灌结果**：解耦了超时，但 agent 当轮拿不到真实 cost/失败，且 mid-generation 竞态难防。MVP 取「慢但正确」。

### 增补-D2 — Layer2 混批顺序与历史不变量 = **写死 Layer1→discard→Layer2，clearEditHistory 仅在真有生成落地时**

一个混批（Layer1 op + 生成 op）的应用顺序**硬编码、不可交错**：

1. **拆批**：partition 成 `layer1Ops` / `discardIds` / `genOps`。
2. **Phase A**：`applyProposalBatch(layer1Ops)` —— 单次快照、单 undo 单元。
3. **discard**：`applyDiscards(discardIds)` —— 软删、不推快照（同三刀）。
4. **Phase B**：串行生成 `genOps`，每张 `addNode` + 落盘。
5. **收尾**：**当且仅当 ≥1 张真落地**才 `clearEditHistory()`。

写死的三条不变量（对抗审计重点盯）：
- **Layer1 严格先于 Layer2，永不交错**。因为 Layer2 的 `addNode` 跨了快照数组边界，收尾 `clearEditHistory()` 会销毁 Layer1 的 undo frame；若 Layer2 先跑，Layer1 快照会在节点集已变后才拍 → `reconcile*Frame` 错配 → 重蹈 #274「跨生成 undo 删节点」。
- **禁止前向引用**：同批内 Layer1 op 不得指向 Layer2 将生成的新节点（连线/移动一张还没生出来的图）。天然被现有 stale-target 防御挡住——新节点 id 由 renderer 在生成后才分配，agent propose 时拿不到，引用必落在 pre-batch live 集外 → skip。MVP 接受「想连新生成的图，下一轮再提议连线」。
- **clearEditHistory 绑定生成成败**：全部生成失败时**不清** Layer1 编辑栈（保住 Layer1 可单次 undo）。clearEditHistory 是 Layer2 成功的代价，不是无条件收尾。

### 增补-D3 — 付费前置审批 = **renderer 为成本权威 + ghost 审批面板即付费闸（无二次 confirm）**

落实横切红线①「付费必须在付费之前审批、阻塞期间零付费调用」：

- **renderer 是成本估算唯一权威，不信 agent 报价**：生成 op 只带 `prompt` / 可选 `model`；预估 ¥ 由 renderer 在预览时查 `estimateImageCostCny(model)` 算（单张 + 合计），显示在审批面板。agent 自报成本一律不作准（防模型幻觉成低价诱导点击）。
- **ghost 审批面板即付费闸，砍掉二次 confirm**：用户在 ghost 预览上看到 op 列表 + 每张生成的预估 ¥ + 合计，点一次 Apply → renderer 才走付费 IPC。**不再弹** `window.confirm`（表单态 `generateVideo` 的二次确认在提议路径下被审批面板取代）。
- **阻塞期间零付费保证**：`proposeCanvasOps`（main 侧）只发提议 + 等裁决，**永不发起任何付费调用**（已是事实，本条对生成 op 再次钉死）。一切付费在 renderer apply 之后。
- **拒绝/超时 = 零花费**。
- **per-op 取舍联动成本**：用户取消勾选某张生成，合计 ¥ 实时只算选中项（复用三刀 per-op 机制）。
- **预估 vs 实际**：付费前显示 `estimateImageCostCny` 预估，付费后真实 `costCny` 挂节点（已有）；增补-D1 await 到落地，故 agent tool output 回灌**真实合计花费**。

### 增补-横切红线（二刀新增，写死）

1. **二刀 MVP 生成 op 只给「文生图」一种**：新增 `generateImage { prompt, model?, aspectRatio? }`。agent 提议的 **editRegion / expand / removeWatermark / 视频 i2v·t2v** 这些「衍生 op」（要绑底图节点 + 更多参数 + 更贵）**暂不给 agent**，留后续单刀。把二刀爆炸半径锁在最简单、最便宜（0.14/张）的付费路径。
2. **agent 不得引入新模型/端点**：`generateImage.model` 若指定，renderer 须校验它是**已配置的可用视觉模型**（复用「只列已配置模型」守卫），否则回退表单默认 `imageModel`。守「配置归设置页、工作 surface 只选」的 IA 铁律。
3. **生成节点落位由 renderer 定**：复用 `nextNodePlacement` 自动落在现有节点右侧，**忽略 agent 建议坐标**（避免重叠数学 + 越权布局）。要排布让 agent 下一轮用 moveNode 提议。
4. **Main 永不直接 mutate / 永不直接付费**：agent 端只产提议数据；付费与 store 变更全在 renderer apply 后。

### 增补 · 实施切分（二刀，待拍板后逐点推进）

1. **契约扩展**：`CanvasProposalOp` 加 `ProposeGenerateImageOp`；`normalizeProposalOp` + `proposeCanvasOps.schema` enum 加 `generateImage` + 校验（prompt 非空、model 可选且白名单、aspectRatio 可选）。纯逻辑 TDD。
2. **出图核抽取**：从 `useDesignCanvasGeneration.generate()` 抽 `generateFromPrompt`，表单路径与提议路径共用，回归现有出图不破。
3. **控制器异步化**：`applyProposal` 改双相（增补-D1/D2），Layer1 同步 + Layer2 串行生成 + 条件 clearEditHistory。注入 `generateFromPrompt` 依赖，保持控制器可测。TDD 锁死顺序不变量 + clearEditHistory 绑成败 + 全失败保 Layer1 undo。
4. **审批面板成本 UI**：ghost 预览面板加每张/合计预估 ¥（`estimateImageCostCny`），per-op 取舍联动；砍 `window.confirm`。i18n（zh/en）。
5. **阻塞超时抬升**：含生成批次用 `USER_QUESTION + 单图预算×N`。
6. **真机 E2E + 真 key dogfood**：提议生成 → 看预估 ¥ → apply → 真烧 wanx 出图落画布 → agent 拿真实 cost；reject 零花费；混批（Layer1+生成）顺序与 undo 行为。
7. **独立 context 对抗审计**修 HIGH/MED（重点：混批历史顺序 + 付费闸不被绕过 + 全失败不清史）。

> 工作纪律同一刀：独立 worktree、TDD、对抗审计、CI 全绿不擅自合、更新 roadmap。**付费 dogfood 默认只跑一次，付费前显式向林晨确认**（[[feedback_paid_dogfood_cost_safety]]）。
