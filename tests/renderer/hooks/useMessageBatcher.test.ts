import { describe, expect, it } from 'vitest';
import { mergeMessageUpdates, type MessageUpdate } from '../../../src/renderer/hooks/useMessageBatcher';

describe('mergeMessageUpdates', () => {
  it('merges streamed text appends for the same assistant message', () => {
    const updates: MessageUpdate[] = [
      { type: 'append', messageId: 'assistant-1', content: 'hel' },
      { type: 'append', messageId: 'assistant-1', content: 'lo', reasoning: 'r1' },
      { type: 'append', messageId: 'assistant-1', reasoning: 'r2' },
    ];

    expect(mergeMessageUpdates(updates)).toEqual([
      { type: 'append', messageId: 'assistant-1', content: 'hello', reasoning: 'r1r2' },
    ]);
  });

  it('merges tool argument deltas per message and tool index', () => {
    const updates: MessageUpdate[] = [
      { type: 'tool_call_delta', messageId: 'assistant-1', index: 0, name: 'Bash', argumentsDelta: '{"cmd":"' },
      { type: 'tool_call_delta', messageId: 'assistant-1', index: 0, argumentsDelta: 'npm test"}' },
      { type: 'tool_call_delta', messageId: 'assistant-1', index: 1, name: 'Read', argumentsDelta: '{"file":"a.ts"}' },
    ];

    expect(mergeMessageUpdates(updates)).toEqual([
      { type: 'tool_call_delta', messageId: 'assistant-1', index: 0, name: 'Bash', argumentsDelta: '{"cmd":"npm test"}' },
      { type: 'tool_call_delta', messageId: 'assistant-1', index: 1, name: 'Read', argumentsDelta: '{"file":"a.ts"}' },
    ]);
  });
});
