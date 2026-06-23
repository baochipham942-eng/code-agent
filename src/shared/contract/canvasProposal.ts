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

/** 第一刀提议 op 判别联合。 */
export type CanvasProposalOp =
  | ProposeMoveNodeOp
  | ProposeAddConnectorOp
  | ProposeAddShapeOp
  | ProposeRenameNodeOp;

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
  const color = isNonEmptyString(r.color) ? r.color : undefined;
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

/** 校验整批提议（过滤非法 op，返回干净 ops + 被丢弃数）。 */
export function normalizeProposal(ops: unknown): { ops: CanvasProposalOp[]; dropped: number } {
  if (!Array.isArray(ops)) return { ops: [], dropped: 0 };
  const clean: CanvasProposalOp[] = [];
  let dropped = 0;
  for (const raw of ops) {
    const op = normalizeProposalOp(raw);
    if (op) clean.push(op);
    else dropped++;
  }
  return { ops: clean, dropped };
}
