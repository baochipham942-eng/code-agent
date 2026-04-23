// ============================================================================
// toolStepGrouping - 把相邻工具调用聚合成自然语言 step label
// 参照 Codex 桌面应用："Explored 2 files, 2 lists, ran 1 command"
// ============================================================================

import type { TraceNode } from '@shared/contract/trace';

interface VerbNoun {
  verb: 'Explored' | 'Ran' | 'Searched' | 'Used';
  noun: string;
}

// Edit/Write 由 TurnDiffSummary 独立渲染，不进 step label
const DIFF_OWNED_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'WritePoc',
  'edit_file',
  'write_file',
  'NotebookEdit',
]);

// 工具名 → (verb, noun) 分类
const TOOL_VERB_MAP: Record<string, VerbNoun> = {
  Read: { verb: 'Explored', noun: 'file' },
  ReadPoc: { verb: 'Explored', noun: 'file' },
  Glob: { verb: 'Explored', noun: 'search' },
  GlobPoc: { verb: 'Explored', noun: 'search' },
  Grep: { verb: 'Explored', noun: 'search' },
  LS: { verb: 'Explored', noun: 'list' },
  list_directory: { verb: 'Explored', noun: 'list' },
  Bash: { verb: 'Ran', noun: 'command' },
  bash: { verb: 'Ran', noun: 'command' },
  WebSearch: { verb: 'Searched', noun: 'query' },
  WebFetch: { verb: 'Searched', noun: 'page' },
};

function classifyTool(name: string): VerbNoun {
  return TOOL_VERB_MAP[name] ?? { verb: 'Used', noun: 'tool' };
}

function pluralize(noun: string, n: number): string {
  return n === 1 ? noun : noun + 's';
}

/**
 * 把一组工具调用聚合成 "Explored 2 files, 2 lists, ran 1 command" 这种字符串
 */
export function buildStepLabel(toolNames: string[]): string {
  // verb → (noun → count)
  const byVerb = new Map<string, Map<string, number>>();
  const verbOrder: string[] = [];

  for (const name of toolNames) {
    const { verb, noun } = classifyTool(name);
    let nounMap = byVerb.get(verb);
    if (!nounMap) {
      nounMap = new Map();
      byVerb.set(verb, nounMap);
      verbOrder.push(verb);
    }
    nounMap.set(noun, (nounMap.get(noun) || 0) + 1);
  }

  const parts: string[] = [];
  let first = true;
  for (const verb of verbOrder) {
    const nounMap = byVerb.get(verb)!;
    const nouns = Array.from(nounMap.entries()).map(
      ([noun, count]) => `${count} ${pluralize(noun, count)}`
    );
    const verbStr = first ? verb : verb.toLowerCase();
    parts.push(`${verbStr} ${nouns.join(', ')}`);
    first = false;
  }

  return parts.join(', ');
}

// ============================================================================
// 节点分组：把相邻的非 Edit/Write 工具调用合成 tool_group
// ============================================================================

export type DisplayNode =
  | { kind: 'node'; node: TraceNode }
  | { kind: 'tool_group'; tools: TraceNode[]; key: string };

/**
 * 最小聚合阈值：少于此数量不走 step group，直接原样展示
 * （单个工具调用看 step label 反而多一层噪音）
 */
export const MIN_GROUP_SIZE = 2;

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
 * 按相邻关系把 turn.nodes 分组：相邻的"非 diff-owned"工具调用合并成 tool_group，
 * 其他节点（user / assistant_text / system / Edit+Write 工具 / turn_timeline）原样保留
 */
export function groupAdjacentToolCalls(nodes: TraceNode[]): DisplayNode[] {
  const result: DisplayNode[] = [];
  let buffer: TraceNode[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
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
