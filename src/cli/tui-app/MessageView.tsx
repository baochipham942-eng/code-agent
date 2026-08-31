// ============================================================================
// Ink TUI 消息渲染：user / assistant(markdown) / thinking 三态 / 工具分组 / system
// markdown 走 marked + marked-terminal 输出 ANSI 字符串喂 <Text>；
// 代码块一期不高亮（esbuild alias 把 cli-highlight stub 成原样返回）。
// ============================================================================

import { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage, ToolCallItem, ToolGroupMessage } from './events';
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

/** 单个工具调用行：bullet + 时态动词 + 参数摘要 + 成功输出截断展示（前 2 后 3 行） */
function ToolCallView({ call }: { call: ToolCallItem }) {
  const done = call.status !== 'running';
  const error = call.status === 'error';
  const color = error ? 'red' : done ? undefined : 'cyan';
  const bullet = error ? '✗' : '◆';
  const verb = done ? call.doneVerb : call.activeVerb;
  const preview = error && call.resultPreview ? call.resultPreview : undefined;
  return (
    <Box flexDirection="column">
      <Text dimColor={done && !error} color={color} wrap="truncate-end">
        {bullet} {verb}
        {call.summary ? <Text dimColor>  {call.summary}</Text> : null}
      </Text>
      {call.outputLines && call.outputLines.length > 0 ? (
        <Text dimColor wrap="wrap">{'  '}{call.outputLines.join('\n  ')}</Text>
      ) : null}
      {preview ? <Text color="red" wrap="truncate-end">  {preview}</Text> : null}
    </Box>
  );
}

function toolGroupHasBody(group: ToolGroupMessage): boolean {
  return group.calls.length > 1
    || group.calls.some((call) => (call.outputLines && call.outputLines.length > 0) || Boolean(call.resultPreview));
}

/** 工具分组：默认折叠一行（Read 5 files / Run cmd ›）；点击或 Ctrl+X 展开结果 */
function ToolGroupView({ group, expanded }: { group: ToolGroupMessage; expanded?: boolean }) {
  const done = group.status !== 'running';
  const error = group.status === 'error';
  const color = error ? 'red' : done ? undefined : 'cyan';
  const bullet = error ? '✗' : '◆';
  const hasBody = toolGroupHasBody(group);

  if (!expanded && hasBody) {
    const grouped = Boolean(group.groupNoun && group.calls.length > 1);
    const verb = done ? group.doneVerb : group.activeVerb;
    const summary = grouped
      ? `${group.calls.length} ${group.groupNoun}s`
      : (group.calls[0]?.summary ?? '');
    const runningSummary = group.status === 'running'
      ? group.calls[group.calls.length - 1]?.summary
      : '';
    return (
      <Text dimColor={done && !error} color={color}>
        {bullet} {verb}{summary ? ` ${summary}` : ''}
        {runningSummary && !grouped ? <Text dimColor>  {runningSummary}</Text> : null}
        <Text dimColor> ›</Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {group.calls.map((call) => (
        <ToolCallView key={call.id} call={call} />
      ))}
      {hasBody ? <Text dimColor>  ‹</Text> : null}
    </Box>
  );
}

function MessageBody({ message, width, maxLines, expandTools }: { message: ChatMessage; width: number; maxLines?: number; expandTools?: boolean }) {
  switch (message.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          {/* 用户消息用青色 ❯ + 加粗与助手正文区分（助手保持默认色，长文阅读不花哨） */}
          <Text color="cyan">{'❯ '}</Text>
          <Text wrap="wrap" bold>{message.text}</Text>
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
          <ToolGroupView group={message} expanded={expandTools} />
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
