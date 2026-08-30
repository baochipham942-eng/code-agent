// ============================================================================
// Ink TUI 消息渲染：user / assistant(markdown) / thinking 三态 / 工具分组 / system
// markdown 走 marked + marked-terminal 输出 ANSI 字符串喂 <Text>；
// 代码块一期不高亮（esbuild alias 把 cli-highlight stub 成原样返回）。
// ============================================================================

import { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage, ToolGroupMessage } from './events';
import { formatDuration } from './events';
import { renderMarkdown } from './markdown';

function AssistantBody({ text, width, maxLines }: { text: string; width: number; maxLines?: number }) {
  const ansi = useMemo(() => {
    const rendered = renderMarkdown(text, width);
    // P3 钉顶行布局：live 区超预算时只保留尾部 maxLines 行
    if (maxLines !== undefined) {
      const lines = rendered.split('\n');
      if (lines.length > maxLines) return lines.slice(-maxLines).join('\n');
    }
    return rendered;
  }, [text, width, maxLines]);
  return <Text wrap="wrap">{ansi}</Text>;
}

/** thinking 三态：运行中加粗标题 + 尾部 3 行灰化；完成折叠单行 "Thought for Xs" */
function ThinkingView({ message }: { message: Extract<ChatMessage, { kind: 'thinking' }> }) {
  if (message.endedAt !== undefined) {
    const duration = formatDuration(message.endedAt - message.startedAt);
    return (
      <Text dimColor wrap="truncate-end">
        {'✶ Thought for '}{duration}
      </Text>
    );
  }
  const lines = message.text.split('\n').filter((line) => line.trim().length > 0);
  const tail = lines.slice(-3).join('\n');
  return (
    <Box flexDirection="column">
      <Text bold dimColor>Thinking…</Text>
      {tail ? <Text dimColor wrap="wrap">{tail}</Text> : null}
    </Box>
  );
}

/** 工具分组：单行 bullet + 时态动词 + 参数摘要；同类连续调用折叠 "Read 3 files" */
function ToolGroupView({ group }: { group: ToolGroupMessage }) {
  const done = group.status !== 'running';
  const error = group.status === 'error';
  const color = error ? 'red' : done ? undefined : 'cyan';
  const bullet = error ? '✗' : '◆';

  // 归组（Read 3 files / Searched 4 patterns）
  if (group.groupNoun && group.calls.length > 1) {
    const plural = group.calls.length === 1 ? group.groupNoun : `${group.groupNoun}s`;
    const verb = done ? group.doneVerb : group.activeVerb;
    const runningSummary = group.status === 'running'
      ? group.calls[group.calls.length - 1]?.summary
      : '';
    return (
      <Text dimColor={done && !error} color={color}>
        {bullet} {verb} {group.calls.length} {plural}
        {runningSummary ? <Text dimColor>  {runningSummary}</Text> : null}
      </Text>
    );
  }

  const call = group.calls[0];
  if (!call) return null;
  const verb = done ? call.doneVerb : call.activeVerb;
  const preview = error && call.resultPreview ? call.resultPreview : undefined;
  return (
    <Box flexDirection="column">
      <Text dimColor={done && !error} color={color} wrap="truncate-end">
        {bullet} {verb}
        {call.summary ? <Text dimColor>  {call.summary}</Text> : null}
      </Text>
      {preview ? <Text color="red" wrap="truncate-end">  {preview}</Text> : null}
    </Box>
  );
}

function MessageBody({ message, width, maxLines }: { message: ChatMessage; width: number; maxLines?: number }) {
  switch (message.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text bold color="green">{'❯ '}</Text>
          <Text bold wrap="wrap">{message.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <AssistantBody text={message.text} width={width} maxLines={maxLines !== undefined ? Math.max(1, maxLines - 1) : undefined} />
        </Box>
      );
    case 'thinking':
      return (
        <Box marginTop={1}>
          <ThinkingView message={message} />
        </Box>
      );
    case 'tool_group':
      return (
        <Box marginTop={1}>
          <ToolGroupView group={message} />
        </Box>
      );
    case 'system': {
      const color = message.tone === 'error' ? 'red' : message.tone === 'warn' ? 'yellow' : undefined;
      return (
        <Box marginTop={1}>
          <Text color={color} dimColor={message.tone === 'info'} wrap="wrap">
            {message.text}
          </Text>
        </Box>
      );
    }
    default:
      return null;
  }
}

export const MessageView = memo(MessageBody);
