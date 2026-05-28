import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { summarizeWrite } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers/editSummarizer';

function writeCall(args: Record<string, unknown>): ToolCall {
  return {
    id: 'w1',
    name: 'Write',
    arguments: args,
    result: { toolCallId: 'w1', success: true },
  } as ToolCall;
}

describe('summarizeWrite — Bug 1: line count on truncated content', () => {
  it('prefers authoritative content_lines when content is a truncated fragment', () => {
    const summary = summarizeWrite(
      writeCall({
        file_path: '/x/breakout.html',
        content: '<!DOCTYPE html>...[20000 chars omitted]...</html>',
        content_lines: 540,
      }),
    );
    // 不再显示对片段 split 出的 ~2/12 行，而是真实行数
    expect(summary).toBe('540 lines');
  });

  it('falls back to splitting content when untruncated (no content_lines)', () => {
    const summary = summarizeWrite(writeCall({ file_path: '/x/s.html', content: 'a\nb\nc' }));
    expect(summary).toBe('3 lines');
  });
});
