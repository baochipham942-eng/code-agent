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
