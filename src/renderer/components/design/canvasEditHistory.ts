// 画布「编辑操作」撤销/重做的纯逻辑历史栈（无 React/Zustand 依赖，可单测）。
// 只管 Layer1：节点移动/缩放/删除/重命名等直接编辑操作的快照。
// 生成/编辑产物（出图/重绘/扩图…）走 Layer2 variant spine，不进本栈。
//
// 设计要点（艾克斯对抗审计修订）：
// - 快照必须深拷贝（structuredClone）——store 的 loadDoc/addNode/toDoc 直接复用 nodes 引用，
//   若历史帧共享引用，后续节点 patch / chosen / discarded 变化会污染历史（codex HIGH-2）。
import type { CanvasNode } from './designCanvasTypes';

/** 编辑历史快照栈：past=可撤销的历史帧，future=已撤销可重做的帧。每帧是一份 nodes 深拷贝。 */
export interface EditHistoryStack {
  past: CanvasNode[][];
  future: CanvasNode[][];
}

/** 历史栈上限，超出丢弃最老帧，限制内存（典型每帧 2-5KB）。 */
export const MAX_EDIT_HISTORY = 50;

function cloneNodes(nodes: CanvasNode[]): CanvasNode[] {
  return structuredClone(nodes);
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
 * 在一次编辑操作「之前」把当前 nodes 推入历史。
 * 深拷贝快照；清空 future（新编辑破坏 redo 链）；超 MAX 丢最老帧。
 */
export function pushSnapshot(stack: EditHistoryStack, nodesBeforeEdit: CanvasNode[]): EditHistoryStack {
  const past = [...stack.past, cloneNodes(nodesBeforeEdit)];
  if (past.length > MAX_EDIT_HISTORY) past.splice(0, past.length - MAX_EDIT_HISTORY);
  return { past, future: [] };
}

/**
 * 撤销：取 past 顶帧作为目标 nodes，把当前 nodes 深拷贝推入 future。
 * past 为空返回 null（无可撤销）。
 */
export function undoEdit(
  stack: EditHistoryStack,
  currentNodes: CanvasNode[],
): { stack: EditHistoryStack; nodes: CanvasNode[] } | null {
  if (stack.past.length === 0) return null;
  const past = stack.past.slice(0, -1);
  const target = stack.past[stack.past.length - 1];
  const future = [...stack.future, cloneNodes(currentNodes)];
  return { stack: { past, future }, nodes: target };
}

/**
 * 重做：取 future 顶帧作为目标 nodes，把当前 nodes 深拷贝推回 past。
 * future 为空返回 null（无可重做）。
 */
export function redoEdit(
  stack: EditHistoryStack,
  currentNodes: CanvasNode[],
): { stack: EditHistoryStack; nodes: CanvasNode[] } | null {
  if (stack.future.length === 0) return null;
  const future = stack.future.slice(0, -1);
  const target = stack.future[stack.future.length - 1];
  const past = [...stack.past, cloneNodes(currentNodes)];
  return { stack: { past, future }, nodes: target };
}

export function canEditUndo(stack: EditHistoryStack): boolean {
  return stack.past.length > 0;
}

export function canEditRedo(stack: EditHistoryStack): boolean {
  return stack.future.length > 0;
}

/**
 * 把"还原帧"与"当前态"调和（修 HIGH-1：undo 整体换数组会抹掉快照之后的 Layer2 变更与新增节点）。
 * Layer1 编辑历史只负责直接编辑（移动/缩放/删除/重命名）；setChosen/discardNode（Layer2）与
 * addNode（import）不进历史栈。直接用还原帧覆盖会丢掉这些。规则：
 * - 帧内节点仍存在于当前态 → 取帧的编辑字段（几何/label），但用当前态的 chosen/discarded 覆盖
 *   （主版选择/淘汰是 Layer2，不该被编辑 undo 还原）。
 * - 帧内节点已不在当前态（被删，正被 undo 恢复）→ 整体用帧（含其快照时的 chosen/discarded）。
 * - 当前态有而帧内没有的节点（快照后 import/生成新增）→ 原样保留，追加在后。
 */
export function reconcileUndoFrame(frame: CanvasNode[], current: CanvasNode[]): CanvasNode[] {
  const currentById = new Map(current.map((n) => [n.id, n]));
  const frameIds = new Set(frame.map((n) => n.id));
  const merged: CanvasNode[] = frame.map((fn) => {
    const cur = currentById.get(fn.id);
    if (!cur) return fn; // 被删节点恢复：用帧（含快照时 Layer2 状态）
    return { ...fn, chosen: cur.chosen, discarded: cur.discarded } as CanvasNode; // 几何还原 + Layer2 保留
  });
  // 快照后新增、当前态独有的节点不能丢。
  for (const cn of current) {
    if (!frameIds.has(cn.id)) merged.push(cn);
  }
  return merged;
}
