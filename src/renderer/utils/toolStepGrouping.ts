// ============================================================================
// toolStepGrouping - 把相邻工具调用聚合成自然语言 step label
// 参照 Codex 桌面应用："Explored 2 files, 2 lists, ran 1 command"
// ============================================================================

import type { TraceNode } from '@shared/contract/trace';

// Edit/Write 由 TurnDiffSummary 独立渲染，不进 step label
const DIFF_OWNED_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'edit_file',
  'write_file',
  'NotebookEdit',
]);

// ============================================================================
// 节点分组：把相邻的非 Edit/Write 工具调用合成 tool_group
// ============================================================================

export type DisplayNode =
  | { kind: 'node'; node: TraceNode }
  | { kind: 'tool_group'; tools: TraceNode[]; key: string };

/**
 * 最小聚合阈值：1 = 所有非 Edit/Write 工具都包成 tool_group，基础态就是 inline 灰字一行
 * （Codex 风格）。Edit/Write 依然走独立卡片路径。
 */
export const MIN_GROUP_SIZE = 1;

/**
 * 判断 tool_call 节点是否归 TurnDiffSummary 管
 */
function isDiffOwnedToolNode(node: TraceNode): boolean {
  return (
    node.type === 'tool_call' &&
    !!node.toolCall &&
    DIFF_OWNED_TOOLS.has(node.toolCall.name)
  );
}

/**
 * hoisted 时间线节点（hook/skill 横幅）：TurnCard 把它们吊到 turn 顶部固定槽渲染，
 * 节点流位置上渲染为 null —— 不应打断工具聚合（否则流式期间组被反复拆开导致跳动）。
 */
function isHoistedTimelineNode(node: TraceNode): boolean {
  const kind = node.turnTimeline?.kind;
  return kind === 'hook_activity' || kind === 'skill_activity' || node.subtype === 'skill_status';
}

/**
 * 按相邻关系把 turn.nodes 分组：相邻的"非 diff-owned"工具调用合并成 tool_group
 * （hoisted 时间线节点不打断聚合），
 * 其他节点（user / assistant_text 含纯思考 / system / Edit+Write 工具）按时序原样保留
 */
export function groupAdjacentToolCalls(nodes: TraceNode[]): DisplayNode[] {
  const result: DisplayNode[] = [];
  let buffer: TraceNode[] = [];

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    if (buffer.length < MIN_GROUP_SIZE) {
      for (const n of buffer) result.push({ kind: 'node', node: n });
    } else {
      result.push({
        kind: 'tool_group',
        tools: buffer,
        key: `tool-group-${buffer[0].id}`,
      });
    }
    buffer = [];
  };

  for (const node of nodes) {
    if (node.type === 'tool_call' && node.toolCall && !isDiffOwnedToolNode(node)) {
      buffer.push(node);
    } else if (isHoistedTimelineNode(node)) {
      // 顶部固定槽已渲染，这里保持原样输出（TurnCard 渲染为 null），但不打断聚合
      result.push({ kind: 'node', node });
    } else {
      flush();
      result.push({ kind: 'node', node });
    }
  }
  flush();

  return result;
}

/**
 * 格式化 turn 时长 ms → "5m 58s" / "23s"
 */
export function formatTurnDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
