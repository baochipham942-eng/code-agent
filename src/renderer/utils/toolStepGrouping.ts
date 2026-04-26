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
  if (n === 1) return noun;
  if (/(sh|ch|x|s|z)$/.test(noun)) return noun + 'es';
  return noun + 's';
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
 * 单个工具调用的 inline label — 带关键参数预览
 * 例如 "Ran ls src/"、"Read index.tsx"、"Searched TODO"
 */
const SINGLE_TOOL_VERB: Record<string, string> = {
  Bash: 'Ran',
  bash: 'Ran',
  Read: 'Read',
  ReadPoc: 'Read',
  Grep: 'Searched',
  Glob: 'Globbed',
  GlobPoc: 'Globbed',
  LS: 'Listed',
  list_directory: 'Listed',
  WebSearch: 'Searched web for',
  WebFetch: 'Fetched',
  browser_action: 'Browser',
  computer_use: 'Computer',
};

const ARG_PREVIEW_MAX = 80;

function takePreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= ARG_PREVIEW_MAX) return trimmed;
  return trimmed.slice(0, ARG_PREVIEW_MAX) + '…';
}

function shortenPath(path: string): string {
  if (!path) return '';
  // 绝对路径取最后两段，避免 /Users/linchen/Downloads/ai/code-agent/src/.../file 占满
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return path;
  return '.../' + segments.slice(-2).join('/');
}

function buildActionPreview(toolLabel: string, args: Record<string, unknown>): string {
  const action = takePreview(args.action);
  if (!action) return toolLabel;

  const rawAction = typeof args.action === 'string' ? args.action : '';
  const isTypingAction = rawAction === 'type' || rawAction === 'smart_type';
  const target = takePreview(
    isTypingAction
      ? args.selector ?? args.targetApp ?? args.role ?? args.name
      : args.selector ?? args.url ?? args.text ?? args.key ?? args.role ?? args.targetApp,
  );

  return target ? `${toolLabel} ${action} ${target}` : `${toolLabel} ${action}`;
}

export function buildSingleToolLabel(
  name: string,
  args: Record<string, unknown> | undefined,
  shortDescription?: string,
): string {
  // 模型若提供了 shortDescription（产品视角语义标签），直接用它作为聚合行的标签，
  // 比机械拼接的 "Ran ls src/" 更接近"在干什么"
  if (typeof shortDescription === 'string' && shortDescription.trim().length > 0) {
    return shortDescription.trim();
  }
  const verb = SINGLE_TOOL_VERB[name];
  const a = args || {};
  let preview = '';

  switch (name) {
    case 'Bash':
    case 'bash':
      preview = takePreview(a.command);
      break;
    case 'Read':
    case 'ReadPoc':
      preview = shortenPath(takePreview(a.file_path ?? a.path));
      break;
    case 'Grep':
      preview = takePreview(a.pattern);
      break;
    case 'Glob':
    case 'GlobPoc':
      preview = takePreview(a.pattern);
      break;
    case 'LS':
    case 'list_directory':
      preview = shortenPath(takePreview(a.path));
      break;
    case 'WebSearch':
      preview = takePreview(a.query);
      break;
    case 'WebFetch':
      preview = takePreview(a.url);
      break;
    case 'browser_action':
    case 'computer_use':
      return buildActionPreview(verb, a);
    default:
      break;
  }

  if (verb && preview) return `${verb} ${preview}`;
  if (verb) return verb;
  // mcp__*, Task, 未识别的 tool：显示 tool name
  return `Called ${name}`;
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
