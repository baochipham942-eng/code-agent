// ============================================================================
// Agent 操作设计画布（人审批）· 提议契约 —— ADR-026
// ----------------------------------------------------------------------------
// 立场：agent 只提议、不直接落地。agent（main）产出**自包含的提议数据**（不依赖
// renderer 画布类型），经 IPC 阻塞等用户审批；批准后由 renderer 经现有 store actions
// 应用（renderer 为新实体分配 id/createdAt，天然尊重编辑历史/variant spine 不变量）。
//
// 第一刀 MVP（Layer1-only，无付费生成）：moveNode / addConnector / addShape / renameNode。
// **不含** addNode（含付费生成，二期）/ deleteNode·discardNode（破坏性，暂不给 agent）。
// ============================================================================

/** 形状几何上限/文本上限与 designDiagramTypes 对齐（此处复述常量避免 shared→renderer 反向依赖）。 */
export const PROPOSAL_TEXT_MAX = 2000;
/** 单批提议 op 数上限（防模型一次吐上万 op 撑爆审批/应用）。超出截断。 */
export const MAX_OPS_PER_PROPOSAL = 100;
/** 形状 color 字符串上限（防超长字符串写进 canvas.json）。 */
export const PROPOSAL_COLOR_MAX = 64;

// ── 单个提议 op（agent 产出；引用已存在节点用 nodeId，新实体不带 id/createdAt 由 renderer 分配）──

/** 移动一个已存在节点到新坐标（Layer1：updateNode x/y）。 */
export interface ProposeMoveNodeOp {
  kind: 'moveNode';
  nodeId: string;
  x: number;
  y: number;
}

/** 在两个已存在节点间加一条连线（Layer1：addConnector；renderer 分配 id/createdAt）。 */
export interface ProposeAddConnectorOp {
  kind: 'addConnector';
  fromNodeId: string;
  toNodeId: string;
  label?: string;
}

/** agent 提议的形状（自包含几何，无 id/createdAt；renderer 分配后经 normalizeShape 落库）。 */
export type ProposedShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; color?: string }
  | { kind: 'ellipse'; x: number; y: number; width: number; height: number; color?: string }
  | { kind: 'sticky'; x: number; y: number; width: number; height: number; text: string; color?: string }
  | { kind: 'text'; x: number; y: number; text: string; color?: string }
  | { kind: 'line'; points: [number, number, number, number]; color?: string };

/** 加一个 freeform 形状/标注（Layer1：addShape）。 */
export interface ProposeAddShapeOp {
  kind: 'addShape';
  shape: ProposedShape;
}

/** 给一个已存在节点改标签（Layer1：renameNode；标注生成步骤）。 */
export interface ProposeRenameNodeOp {
  kind: 'renameNode';
  nodeId: string;
  label: string;
}

/**
 * 淘汰（软删）一个已存在节点（三刀）。走 store.discardNode：标记 discarded、节点留盘可恢复，
 * **非破坏性**。不进 Layer1 撤销批（与人类淘汰一致），靠画布「已淘汰·恢复」入口找回。
 */
export interface ProposeDiscardNodeOp {
  kind: 'discardNode';
  nodeId: string;
}

/** 提议 op 判别联合（一刀 Layer1 四种 + 三刀 discardNode 软删）。 */
export type CanvasProposalOp =
  | ProposeMoveNodeOp
  | ProposeAddConnectorOp
  | ProposeAddShapeOp
  | ProposeRenameNodeOp
  | ProposeDiscardNodeOp;

/** agent 一次提交的一批提议。 */
export interface CanvasOpProposal {
  /** 关联请求 id（IPC 往返 + 阻塞工具 resolve 用）。 */
  requestId: string;
  ops: CanvasProposalOp[];
  /** 一句话给用户看的「为什么这么改」。 */
  rationale?: string;
}

/** 用户对一次提议的裁决（renderer → 阻塞工具）。 */
export interface CanvasProposalDecision {
  requestId: string;
  /** apply=批准整批应用；reject=拒绝（feedback 回 agent 作修改意见）。 */
  verdict: 'apply' | 'reject';
  feedback?: string;
  /** verdict=apply 时 renderer 回灌的应用结果（让 agent 知道实际落地几条、跳过几条 stale）。 */
  appliedCount?: number;
  skippedCount?: number;
}

// ── D1-B 画布快照（renderer → agent 上下文注入；轻量、限长，agent 据此引用真实节点 id）──

/** 注入上下文的节点数 上限（防大画布撑爆 prompt；超出截断并标记）。 */
export const CANVAS_SNAPSHOT_MAX_NODES = 40;

export interface CanvasSnapshotNode {
  id: string;
  /** 节点标签或生成 prompt（让 agent 知道这是哪个屏/产物）。 */
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind?: 'image' | 'video';
}

export interface CanvasSnapshotConnector {
  fromNodeId: string;
  toNodeId: string;
  label?: string;
}

/** 画布当前态的轻量快照（运行时态，不进 DB）。 */
export interface CanvasSnapshot {
  nodes: CanvasSnapshotNode[];
  connectors: CanvasSnapshotConnector[];
  /** 形状只给计数（freeform 标注，agent 一般不需逐个引用）。 */
  shapeCount: number;
  /** 是否因超 CANVAS_SNAPSHOT_MAX_NODES 截断了节点列表。 */
  truncated?: boolean;
}

/**
 * 把画布快照格式化为注入 system context 的文本块。空画布返回 null（无可注入）。
 * 节点超上限则截断并提示——agent 只能对快照里列出的节点提议 op（stale-target 由应用引擎兜底）。
 */
export function formatCanvasSnapshotForPrompt(snap: CanvasSnapshot | undefined | null): string | null {
  if (!snap || !Array.isArray(snap.nodes) || snap.nodes.length === 0) return null;
  const capped = snap.nodes.slice(0, CANVAS_SNAPSHOT_MAX_NODES);
  const lines: string[] = [];
  lines.push('设计画布当前内容（你可以用 ProposeCanvasOps 提议排布/连线/标注，仅能引用下列节点 id）：');
  lines.push(`节点（${snap.nodes.length} 个${snap.truncated || snap.nodes.length > CANVAS_SNAPSHOT_MAX_NODES ? '，仅列前 ' + CANVAS_SNAPSHOT_MAX_NODES + ' 个' : ''}）：`);
  for (const n of capped) {
    const label = n.label ? ` "${n.label.slice(0, 60)}"` : '';
    const k = n.kind === 'video' ? 'video' : 'image';
    lines.push(`- ${n.id}${label} [${k}] @(${Math.round(n.x)},${Math.round(n.y)}) ${Math.round(n.width)}×${Math.round(n.height)}`);
  }
  if (snap.connectors.length > 0) {
    const connCapped = snap.connectors.length > CANVAS_SNAPSHOT_MAX_NODES;
    lines.push(`已有连线（${snap.connectors.length}${connCapped ? '，仅列前 ' + CANVAS_SNAPSHOT_MAX_NODES + ' 条' : ''}）：`);
    for (const c of snap.connectors.slice(0, CANVAS_SNAPSHOT_MAX_NODES)) {
      lines.push(`- ${c.fromNodeId} → ${c.toNodeId}${c.label ? ` "${c.label.slice(0, 40)}"` : ''}`);
    }
    if (connCapped) lines.push('（连线已截断，提议前可先确认目标连线是否已存在，避免重复。）');
  }
  if (snap.shapeCount > 0) lines.push(`已有 freeform 形状/标注：${snap.shapeCount} 个。`);
  return lines.join('\n');
}

// ── 校验/归一化（main 侧产出与 renderer 侧消费共用，防破损 op 进流程）──

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 校验单个 op；非法返回 null（由调用方过滤 + 计入 skipped）。 */
export function normalizeProposalOp(raw: unknown): CanvasProposalOp | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'moveNode':
      if (!isNonEmptyString(r.nodeId) || !isFiniteNumber(r.x) || !isFiniteNumber(r.y)) return null;
      return { kind: 'moveNode', nodeId: r.nodeId, x: r.x, y: r.y };
    case 'addConnector': {
      if (!isNonEmptyString(r.fromNodeId) || !isNonEmptyString(r.toNodeId)) return null;
      if (r.fromNodeId === r.toNodeId) return null; // 自环无意义
      const op: ProposeAddConnectorOp = { kind: 'addConnector', fromNodeId: r.fromNodeId, toNodeId: r.toNodeId };
      if (isNonEmptyString(r.label)) op.label = r.label.slice(0, PROPOSAL_TEXT_MAX);
      return op;
    }
    case 'renameNode':
      if (!isNonEmptyString(r.nodeId) || !isNonEmptyString(r.label)) return null;
      return { kind: 'renameNode', nodeId: r.nodeId, label: r.label.slice(0, PROPOSAL_TEXT_MAX) };
    case 'discardNode':
      if (!isNonEmptyString(r.nodeId)) return null;
      return { kind: 'discardNode', nodeId: r.nodeId };
    case 'addShape': {
      const shape = normalizeProposedShape(r.shape);
      if (!shape) return null;
      return { kind: 'addShape', shape };
    }
    default:
      return null;
  }
}

/** 校验 agent 提议的形状几何；非法返回 null。 */
export function normalizeProposedShape(raw: unknown): ProposedShape | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const color = isNonEmptyString(r.color) ? r.color.slice(0, PROPOSAL_COLOR_MAX) : undefined;
  const text = typeof r.text === 'string' ? r.text.slice(0, PROPOSAL_TEXT_MAX) : '';
  switch (r.kind) {
    case 'rect':
    case 'ellipse':
      if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
      return { kind: r.kind, x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number, ...(color ? { color } : {}) };
    case 'sticky':
      if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
      return { kind: 'sticky', x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number, text, ...(color ? { color } : {}) };
    case 'text':
      if (![r.x, r.y].every(isFiniteNumber)) return null;
      return { kind: 'text', x: r.x as number, y: r.y as number, text, ...(color ? { color } : {}) };
    case 'line':
      if (!Array.isArray(r.points) || r.points.length !== 4 || !r.points.every(isFiniteNumber)) return null;
      return { kind: 'line', points: [r.points[0], r.points[1], r.points[2], r.points[3]] as [number, number, number, number], ...(color ? { color } : {}) };
    default:
      return null;
  }
}

/** 校验整批提议（过滤非法 op + 截断到 MAX_OPS_PER_PROPOSAL，返回干净 ops + 被丢弃数）。 */
export function normalizeProposal(ops: unknown): { ops: CanvasProposalOp[]; dropped: number } {
  if (!Array.isArray(ops)) return { ops: [], dropped: 0 };
  const clean: CanvasProposalOp[] = [];
  let dropped = 0;
  for (const raw of ops) {
    if (clean.length >= MAX_OPS_PER_PROPOSAL) { dropped++; continue; } // 超上限的一律丢弃
    const op = normalizeProposalOp(raw);
    if (op) clean.push(op);
    else dropped++;
  }
  return { ops: clean, dropped };
}
