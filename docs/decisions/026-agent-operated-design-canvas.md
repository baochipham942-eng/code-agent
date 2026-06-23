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
