// ============================================================================
// turnFoldVisibility - 折叠可见性判据：TurnCard 中间渲染区（展开态才画的那块）
// 里哪些节点实际可见。两个消费点共用这一份，改一边漏另一边必漂移：
//   1. TurnCard 展开态的中间区跳过规则（isNodeSkippedInMiddle）
//   2. 折叠是否真藏住了东西（hasFoldHiddenMiddle）——「用时」折叠行只有在
//      藏住至少一个中间节点时才有意义，纯问答轮折了个寂寞不出折叠行。
// ============================================================================
import type { TraceNode } from '@shared/contract/trace';
import type { DisplayNode } from '../../../utils/toolStepGrouping';
import { isFileChangeCardOwnedNode } from '../../../utils/turnDiffSummary';

/**
 * 这个节点是否被中间渲染区跳过（在轮的其它固定位置渲染，或完全不渲染）。
 * finalTextAnchoredBelow：折叠态下结论挪到卡外固定槽渲染（展开且不可折叠时
 * 它仍留在中间流里，TurnCard 按 canFold 传参）。
 */
export function isNodeSkippedInMiddle(
  node: TraceNode,
  userNode: TraceNode | null | undefined,
  finalTextNode: TraceNode | null | undefined,
  finalTextAnchoredBelow: boolean,
): boolean {
  // 用户消息置顶渲染
  if (node.id === userNode?.id) return true;
  // hook/skill 活动吊到轮顶横幅
  if (node.turnTimeline?.kind === 'hook_activity' || node.turnTimeline?.kind === 'skill_activity') return true;
  // 产物/来源锚到最终答案之后
  if (node.turnTimeline?.kind === 'artifact_ownership') return true;
  if (node.subtype === 'skill_status') return true;
  // 压缩摘要降级为操作行右端标记
  if (node.type === 'system' && node.subtype === 'compaction') return true;
  // 文件改动只由文件变更卡讲一遍（未完成/失败的写入不在此列，仍留在节点流）
  if (isFileChangeCardOwnedNode(node) && !node.metadata?.streamInterruptionReason) return true;
  // 折叠态下结论显示在卡外
  if (finalTextAnchoredBelow && node.id === finalTextNode?.id) return true;
  return false;
}

/**
 * 折叠这轮会真藏住至少一个中间节点吗。纯问答轮（user + 结论）谁也藏不住，
 * 按不可折叠处理——不出「用时」空开关，结论直接跟在提问后面。
 */
export function hasFoldHiddenMiddle(
  displayNodes: DisplayNode[],
  userNode: TraceNode | null | undefined,
  finalTextNode: TraceNode | null | undefined,
): boolean {
  return displayNodes.some((display) => (
    display.kind === 'tool_group'
      ? display.tools.length > 0
      : !isNodeSkippedInMiddle(display.node, userNode, finalTextNode, true)
  ));
}
