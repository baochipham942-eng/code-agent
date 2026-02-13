// ============================================================================
// SubagentCompaction - Unit Tests
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import {
  compactSubagentMessages,
  type SubagentMessage,
} from '../../../src/main/agent/subagentCompaction';
import {
  CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  SUBAGENT_COMPACTION,
} from '../../../src/shared/constants';

// Mock logger to capture log output
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn((...args: unknown[]) => console.log('[SubagentCompaction]', ...args)),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Helper: generate a realistic subagent conversation with N tool call rounds.
 * Each round = 1 assistant message (tool call desc) + 1 user message (tool result).
 */
function buildConversation(rounds: number, resultSize = 2000): SubagentMessage[] {
  const messages: SubagentMessage[] = [
    { role: 'system', content: 'You are a helpful coding assistant. Use tools to solve the task.' },
    { role: 'user', content: 'Please analyze the file src/main/agent/agentLoop.ts and fix any bugs.' },
  ];

  for (let i = 0; i < rounds; i++) {
    // Assistant: tool call description
    messages.push({
      role: 'assistant',
      content: `Calling read_file({"file_path":"src/main/agent/agentLoop.ts","offset":${i * 100},"limit":100})`,
    });
    // User: tool result (simulating large output)
    messages.push({
      role: 'user',
      content: `Tool read_file: Success\n${'x'.repeat(resultSize)}`,
    });
  }

  return messages;
}

describe('compactSubagentMessages', () => {
  it('should NOT compact when token count is below threshold', () => {
    // Small conversation: 3 rounds with small results
    const messages = buildConversation(3, 100);
    const result = compactSubagentMessages(messages, 'kimi-k2.5');
    expect(result).toBe(false);
  });

  it('should compact when token count exceeds threshold', () => {
    // Use deepseek-chat (64K context) so threshold = 51.2K tokens
    // 30 rounds × 8KB ≈ 240KB chars ÷ 3.5 ≈ 68K tokens > 51.2K → triggers
    const messages = buildConversation(30, 8000);
    const originalLength = messages.length;

    const result = compactSubagentMessages(messages, 'deepseek-chat');
    expect(result).toBe(true);

    // Message count stays the same (in-place truncation, not removal)
    expect(messages.length).toBe(originalLength);

    // Head preserved: system + initial user untouched
    expect(messages[0].content).toContain('You are a helpful');
    expect(messages[1].content).toContain('Please analyze');

    // Tail preserved: last 6 messages (3 pairs) should be full-length
    const tailStart = messages.length - SUBAGENT_COMPACTION.PRESERVE_RECENT_PAIRS * 2;
    for (let i = tailStart; i < messages.length; i++) {
      const content = messages[i].content as string;
      expect(content).not.toContain('[truncated]');
    }

    // Middle user messages should be truncated
    const middleUserMsg = messages[4].content as string; // 2nd tool result
    expect(middleUserMsg.length).toBeLessThanOrEqual(
      SUBAGENT_COMPACTION.TOOL_RESULT_MAX_CHARS + 20 // +20 for '... [truncated]'
    );
  });

  it('should preserve head (system + initial user) and tail messages', () => {
    // Use deepseek-chat (64K) to ensure compaction triggers
    const messages = buildConversation(30, 8000);

    const systemContent = messages[0].content;
    const userContent = messages[1].content;
    const tailMessages = messages.slice(-6).map((m) => ({ ...m })); // deep copy tails

    const result = compactSubagentMessages(messages, 'deepseek-chat');
    expect(result).toBe(true);

    // Head unchanged
    expect(messages[0].content).toBe(systemContent);
    expect(messages[1].content).toBe(userContent);

    // Tail unchanged
    const newTail = messages.slice(-6);
    for (let i = 0; i < 6; i++) {
      expect(newTail[i].content).toBe(tailMessages[i].content);
    }
  });

  it('should NOT compact when message count is too small', () => {
    // Only 2 messages (system + user), nothing to truncate
    const messages: SubagentMessage[] = [
      { role: 'system', content: 'x'.repeat(100000) },
      { role: 'user', content: 'x'.repeat(100000) },
    ];
    // Even though token count may be high, there's no middle to truncate
    const result = compactSubagentMessages(messages, 'kimi-k2.5');
    expect(result).toBe(false);
  });

  it('should handle unknown model by using DEFAULT_CONTEXT_WINDOW', () => {
    const messages = buildConversation(30, 8000);
    // Unknown model should fallback to DEFAULT_CONTEXT_WINDOW (128K)
    const result = compactSubagentMessages(messages, 'unknown-model-xyz');
    // Should still work without error
    expect(typeof result).toBe('boolean');
  });

  it('should truncate assistant messages to ASSISTANT_MAX_CHARS', () => {
    // Use deepseek-chat (64K) to ensure compaction triggers
    const messages = buildConversation(30, 8000);

    // Make a middle assistant message very long
    messages[2].content = 'Calling tool_with_very_long_args(' + 'a'.repeat(1000) + ')';

    const result = compactSubagentMessages(messages, 'deepseek-chat');
    expect(result).toBe(true);

    // Middle assistant message (index 2) should be truncated
    const assistantContent = messages[2].content as string;
    expect(assistantContent.length).toBeLessThanOrEqual(
      SUBAGENT_COMPACTION.ASSISTANT_MAX_CHARS + 20
    );
  });

  it('should skip multimodal messages in middle section', () => {
    // Use deepseek-chat (64K) to ensure compaction triggers
    const messages = buildConversation(20, 8000);

    // Replace a middle message with multimodal content
    messages[3] = {
      role: 'user',
      content: [
        { type: 'text', text: 'Image analysis result' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
      ],
    };

    // Should not throw
    const result = compactSubagentMessages(messages, 'deepseek-chat');
    expect(typeof result).toBe('boolean');

    // Multimodal message should be unchanged
    expect(Array.isArray(messages[3].content)).toBe(true);
  });
});
