// 画布「编辑操作」撤销/重做的纯逻辑历史栈（无 React/Zustand 依赖，可单测）。
// 只管 Layer1：直接编辑操作的快照——节点移动/缩放/删除/重命名，以及图解层
// （连线/形状）的增删改。生成/编辑产物（出图/重绘/扩图…）走 Layer2 variant spine，不进本栈。
//
// 帧 = 全画布编辑态快照 CanvasEditSnapshot{nodes, connectors, shapes}（统一单栈，
// 一次 Cmd+Z 撤销最近一步无论改的是节点还是图解）。
//
// 设计要点（艾克斯对抗审计修订）：
// - 快照必须深拷贝（structuredClone）——store 的 loadDoc/addNode/toDoc 直接复用引用，
//   若历史帧共享引用，后续 patch / chosen / discarded 变化会污染历史（codex HIGH-2）。
// - nodes 有 Layer2 语义（chosen/discarded），undo 还原需调和（reconcileUndoFrame）；
//   connectors/shapes 无 Layer2，整帧还原即可（每次图解变更都压一帧，帧即权威）。
import type { CanvasNode } from './designCanvasTypes';
import type { CanvasConnector, CanvasShape } from './designDiagramTypes';

/** 一帧全画布编辑态快照（节点 + 图解层）。 */
export interface CanvasEditSnapshot {
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  shapes: CanvasShape[];
}

/** 编辑历史快照栈：past=可撤销的历史帧，future=已撤销可重做的帧。 */
export interface EditHistoryStack {
  past: CanvasEditSnapshot[];
  future: CanvasEditSnapshot[];
}

/** 历史栈上限，超出丢弃最老帧，限制内存。 */
export const MAX_EDIT_HISTORY = 50;

function cloneSnapshot(s: CanvasEditSnapshot): CanvasEditSnapshot {
  return structuredClone(s);
}

/** 空历史栈。 */
export function emptyEditHistory(): EditHistoryStack {
  return { past: [], future: [] };
}

/** 等价于 emptyEditHistory：生成操作 / loadDoc / resetCanvas 时清空历史。 */
export function clearHistory(): EditHistoryStack {
  return emptyEditHistory();
}

/**
 * 在一次编辑操作「之前」把当前快照推入历史。
 * 深拷贝；清空 future（新编辑破坏 redo 链）；超 MAX 丢最老帧。
 */
export function pushSnapshot(stack: EditHistoryStack, before: CanvasEditSnapshot): EditHistoryStack {
  const past = [...stack.past, cloneSnapshot(before)];
  if (past.length > MAX_EDIT_HISTORY) past.splice(0, past.length - MAX_EDIT_HISTORY);
  return { past, future: [] };
}

/**
 * 撤销：取 past 顶帧作为目标，把当前快照深拷贝推入 future。
 * past 为空返回 null（无可撤销）。
 */
export function undoEdit(
  stack: EditHistoryStack,
  current: CanvasEditSnapshot,
): { stack: EditHistoryStack; snapshot: CanvasEditSnapshot } | null {
  if (stack.past.length === 0) return null;
  const past = stack.past.slice(0, -1);
  const target = stack.past[stack.past.length - 1];
  const future = [...stack.future, cloneSnapshot(current)];
  return { stack: { past, future }, snapshot: target };
}

/**
 * 重做：取 future 顶帧作为目标，把当前快照深拷贝推回 past。
 * future 为空返回 null（无可重做）。
 */
export function redoEdit(
  stack: EditHistoryStack,
  current: CanvasEditSnapshot,
): { stack: EditHistoryStack; snapshot: CanvasEditSnapshot } | null {
  if (stack.future.length === 0) return null;
  const future = stack.future.slice(0, -1);
  const target = stack.future[stack.future.length - 1];
  const past = [...stack.past, cloneSnapshot(current)];
  return { stack: { past, future }, snapshot: target };
}

export function canEditUndo(stack: EditHistoryStack): boolean {
  return stack.past.length > 0;
}

export function canEditRedo(stack: EditHistoryStack): boolean {
  return stack.future.length > 0;
}

/**
 * 把"还原帧"与"当前态"调和（修 HIGH-1：undo 整体换数组会抹掉快照之后的 Layer2 变更与新增节点）。
 * - nodes：Layer1 编辑历史只负责直接编辑（移动/缩放/删除/重命名）；setChosen/discardNode（Layer2）
 *   与 addNode（生成/import）不进历史栈，直接用还原帧覆盖会丢掉这些。规则同原实现：
 *   - 帧内节点仍存在于当前态 → 取帧的编辑字段（几何/label），但用当前态的 chosen/discarded 覆盖。
 *   - 帧内节点已不在当前态（被删，正被 undo 恢复）→ 整体用帧（含其快照时的 chosen/discarded）。
 *   - 当前态有而帧内没有的节点（快照后 import/生成新增）→ 原样保留，追加在后。
 * - connectors/shapes：无 Layer2、每次变更都压帧，故帧即权威，整帧还原。
 */
export function reconcileUndoFrame(
  frame: CanvasEditSnapshot,
  current: CanvasEditSnapshot,
): CanvasEditSnapshot {
  const currentById = new Map(current.nodes.map((node) => [node.id, node]));
  const frameIds = new Set(frame.nodes.map((node) => node.id));
  const nodes: CanvasNode[] = frame.nodes.map((fn) => {
    const cur = currentById.get(fn.id);
    if (!cur) return fn; // 被删节点恢复：用帧（含快照时 Layer2 状态）
    return { ...fn, chosen: cur.chosen, discarded: cur.discarded } as CanvasNode; // 几何还原 + Layer2 保留
  });
  // 快照后新增、当前态独有的节点不能丢。
  for (const cn of current.nodes) {
    if (!frameIds.has(cn.id)) nodes.push(cn);
  }
  return { nodes, connectors: frame.connectors, shapes: frame.shapes };
}
