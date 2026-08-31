// ============================================================================
// Ink 底栏/提示条展示组件（从 App 拆出，压 max-lines）
// ============================================================================

import { Box, Text } from 'ink';
import { estimateCostUsd, formatDuration, type ChatState } from './events';
import { formatStatusBar } from './statusBar';
import { QUEUE_ACTIONS, truncateQueueText, type QueueActionId } from './queueBar';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

function activityColor(activity: string | null): string {
  if (!activity) return 'cyan';
  if (/^Thinking/.test(activity)) return 'magenta';
  if (/^(Running|Run)/.test(activity)) return 'yellow';
  if (/^(Writing|Editing|Appending|Deleting|Wrote|Edited)/.test(activity)) return 'red';
  return 'cyan';
}

export function StatusBar({ state, gitBranch, gitDirty, fallbackModel, fallbackProvider, permissionLabel, columns }: {
  state: ChatState;
  gitBranch: string;
  gitDirty?: boolean;
  fallbackModel: string;
  fallbackProvider?: string;
  permissionLabel: string;
  columns: number;
}) {
  const model = state.model ?? fallbackModel;
  const provider = state.provider ?? fallbackProvider ?? '';
  const cost = estimateCostUsd(model, state.inputTokens, state.outputTokens);
  const { left, right } = formatStatusBar({
    permissionLabel,
    model,
    provider,
    gitBranch,
    gitDirty,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    contextPercent: state.contextPercent,
    costUsd: cost,
  });
  return (
    <Box paddingX={1} width={columns} justifyContent="space-between">
      <Text wrap="truncate-end">{left}</Text>
      {right ? <Text dimColor wrap="truncate-end">{right}</Text> : null}
    </Box>
  );
}

export function ShortcutsBar({ running, menuOpen, hasDraft, approvalOpen, searchOpen, queued }: {
  running: boolean;
  menuOpen: boolean;
  hasDraft: boolean;
  approvalOpen: boolean;
  searchOpen: boolean;
  queued: boolean;
}) {
  const text = approvalOpen
    ? '数字直选 · ↑↓ 选择 · Enter 确认 · Tab diff · Esc 拒绝'
    : searchOpen
      ? '输入过滤 · Ctrl+R 下一条 · Enter 采纳 · Esc 取消'
      : menuOpen
        ? '↑↓ 选择 · Tab 采纳 · Enter 采纳/执行 · Esc 关闭'
        : queued
          ? '点队列正文编辑 · [Send now] 下轮发出 · [cancel] 丢弃'
          : running
            ? 'Esc 取消 · 带文本 Enter 排队 · Shift+Enter 换行'
            : hasDraft
              ? 'Enter 提交 · Ctrl+C 清草稿 · Shift+Enter 换行'
              : '/ 命令 · ↑ 历史 · Ctrl+R 搜索 · Ctrl+Q 双击退出';
  return (
    <Box paddingX={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

export function Toast({ text }: { text: string }) {
  return (
    <Box paddingX={1} justifyContent="flex-end">
      <Text dimColor>{text}</Text>
    </Box>
  );
}

export function TurnStatus({ state, frame, now }: {
  state: ChatState;
  frame: number;
  now: number;
}) {
  const elapsed = state.turnStartedAt != null ? now - state.turnStartedAt : 0;
  return (
    <Box paddingX={1}>
      <Text>
        <Text color={activityColor(state.activity)}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} </Text>
        <Text color={activityColor(state.activity)}>{state.activity ?? 'Working…'}</Text>
        <Text dimColor>  {formatDuration(elapsed)}</Text>
        {state.outputTokens > 0 ? <Text dimColor>  ⇣{state.outputTokens}</Text> : null}
      </Text>
    </Box>
  );
}

export function QueueBar({ items, columns, hover }: {
  items: string[];
  columns: number;
  hover: QueueActionId | 'body' | null;
}) {
  const preview = truncateQueueText(items[0] ?? '', columns);
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="cyan">{`#${items.length} `}</Text>
        <Text inverse={hover === 'body'}>{preview}</Text>
      </Text>
      <Text>
        {QUEUE_ACTIONS.map((action) => (
          <Text key={action.id} inverse={hover === action.id}>{`[${action.label}]`}</Text>
        ))}
      </Text>
    </Box>
  );
}

export function HistorySearchBar({ query, match }: { query: string; match: string | null }) {
  const preview = match
    ? (match.split('\n').length > 1 ? `${match.split('\n')[0]} ⏎(${match.split('\n').length} 行)` : match)
    : '（无匹配）';
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color="cyan">(reverse-search) </Text>
        <Text>{`'${query}'`}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">  {preview}</Text>
    </Box>
  );
}
