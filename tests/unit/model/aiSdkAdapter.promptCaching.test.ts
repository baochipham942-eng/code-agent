// ============================================================================
// AI SDK Prompt Caching 断点注入测试 (GAP-003)
// ============================================================================
//
// 验证 Anthropic prompt caching 断点在 AI SDK 路径正确注入：
// - anthropic/claude provider：system 消息 + 倒数第二条对话消息打 cacheControl 断点
// - 其他 provider：消息原样不动（DeepSeek/Kimi 服务端自动缓存，无需断点）
//
// 背景：旧 claudeProvider 路径默认开启 caching，AI SDK 迁移时丢失（成本回归）。
// 课程依据：《Claude Code 工程化实战》H3 五项上下文工程优化之"分界标记 + 全局缓存"

import { describe, it, expect } from 'vitest';
import { applyAnthropicCacheBreakpoints } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { ModelMessage as AiModelMessage } from 'ai';

type MessageWithOptions = AiModelMessage & {
  providerOptions?: Record<string, Record<string, unknown>>;
};

function getCacheControl(message: AiModelMessage): unknown {
  return (message as MessageWithOptions).providerOptions?.anthropic?.cacheControl;
}

const SAMPLE_MESSAGES: AiModelMessage[] = [
  { role: 'system', content: 'You are Agent Neo, a cowork assistant.' },
  { role: 'user', content: 'First user message' },
  { role: 'assistant', content: 'First assistant reply' },
  { role: 'user', content: 'Second user message' },
  { role: 'assistant', content: 'Second assistant reply' },
  { role: 'user', content: 'Latest user message' },
];

describe('applyAnthropicCacheBreakpoints (GAP-003)', () => {
  describe('anthropic/claude provider', () => {
    it('marks the system message with cacheControl (断点 1: tools + system 前缀)', () => {
      const result = applyAnthropicCacheBreakpoints(SAMPLE_MESSAGES, 'claude');

      expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' });
    });

    it('marks the second-to-last non-system message (断点 2: 对话历史增量)', () => {
      const result = applyAnthropicCacheBreakpoints(SAMPLE_MESSAGES, 'claude');

      // 非 system 消息: indices 1..5，倒数第二条是 index 4 (Second assistant reply)
      expect(getCacheControl(result[4])).toEqual({ type: 'ephemeral' });
      // 最后一条（本轮新输入）不打断点
      expect(getCacheControl(result[5])).toBeUndefined();
    });

    it('works for "anthropic" provider name too', () => {
      const result = applyAnthropicCacheBreakpoints(SAMPLE_MESSAGES, 'anthropic');

      expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' });
    });

    it('does not mutate the original messages array', () => {
      const original = SAMPLE_MESSAGES.map(m => ({ ...m }));
      applyAnthropicCacheBreakpoints(SAMPLE_MESSAGES, 'claude');

      for (let i = 0; i < SAMPLE_MESSAGES.length; i++) {
        expect(getCacheControl(SAMPLE_MESSAGES[i])).toBeUndefined();
        expect(SAMPLE_MESSAGES[i]).toEqual(original[i]);
      }
    });

    it('handles single-message conversation (only system breakpoint)', () => {
      const messages: AiModelMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Only message' },
      ];
      const result = applyAnthropicCacheBreakpoints(messages, 'claude');

      expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' });
      // 只有一条非 system 消息 → 无历史断点
      expect(getCacheControl(result[1])).toBeUndefined();
    });

    it('handles conversation without system message', () => {
      const messages: AiModelMessage[] = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Second' },
      ];
      const result = applyAnthropicCacheBreakpoints(messages, 'claude');

      // 无 system → 只有历史断点（倒数第二条 = index 1）
      expect(getCacheControl(result[1])).toEqual({ type: 'ephemeral' });
    });

    it('preserves existing providerOptions when adding cacheControl', () => {
      const messages: AiModelMessage[] = [
        {
          role: 'system',
          content: 'System',
          providerOptions: { anthropic: { customField: 'keep-me' } },
        } as AiModelMessage,
        { role: 'user', content: 'Hi' },
      ];
      const result = applyAnthropicCacheBreakpoints(messages, 'claude');
      const options = (result[0] as MessageWithOptions).providerOptions?.anthropic;

      expect(options?.customField).toBe('keep-me');
      expect(options?.cacheControl).toEqual({ type: 'ephemeral' });
    });
  });

  describe('non-anthropic providers', () => {
    it.each(['deepseek', 'moonshot', 'zhipu', 'xiaomi', 'gemini', 'openrouter'])(
      '%s: messages pass through unchanged',
      (provider) => {
        const result = applyAnthropicCacheBreakpoints(SAMPLE_MESSAGES, provider);

        expect(result).toBe(SAMPLE_MESSAGES); // 同一引用，零开销
        for (const msg of result) {
          expect(getCacheControl(msg)).toBeUndefined();
        }
      },
    );
  });

  describe('edge cases', () => {
    it('empty messages array returns as-is', () => {
      const result = applyAnthropicCacheBreakpoints([], 'claude');
      expect(result).toEqual([]);
    });
  });
});
