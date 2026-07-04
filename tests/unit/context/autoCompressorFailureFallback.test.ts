import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompressedMessage } from '../../../src/host/context/tokenOptimizer';

// WP2-3 失败弹性：AI 摘要调用失败时回退「保留原文」而非 truncate——
// truncate 会破坏内容且不可逆；保留原文本轮不压，交给下轮重试/确定性层/溢出恢复兜底。

const fallbackMocks = vi.hoisted(() => ({
  summarize: vi.fn(),
}));

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarize: fallbackMocks.summarize,
}));

import { AutoContextCompressor } from '../../../src/host/context/autoCompressor';

interface CompressorInternals {
  applyAISummary(
    messages: CompressedMessage[],
    systemPrompt: string,
    preservedContext?: string,
  ): Promise<{ compressed: boolean; messages: CompressedMessage[]; savedTokens: number; strategy?: string }>;
}

function msg(role: string, content: string): CompressedMessage {
  return { role, content };
}

function history(): CompressedMessage[] {
  return [
    msg('user', 'first long question about the data pipeline '.repeat(30)),
    msg('assistant', 'long detailed answer one '.repeat(30)),
    msg('user', 'second question '.repeat(30)),
    msg('assistant', 'long detailed answer two '.repeat(30)),
    msg('user', 'third question '.repeat(30)),
    msg('assistant', 'long detailed answer three '.repeat(30)),
    msg('user', 'recent question'),
    msg('assistant', 'recent answer'),
  ];
}

describe('AutoContextCompressor AI summary failure fallback (WP2-3)', () => {
  beforeEach(() => {
    fallbackMocks.summarize.mockReset();
  });

  it('summary call throws → keeps original messages untouched (no truncate)', async () => {
    fallbackMocks.summarize.mockRejectedValue(new Error('model unavailable'));
    const compressor = new AutoContextCompressor({ preserveRecentCount: 2 });
    const messages = history();

    const result = await (compressor as unknown as CompressorInternals).applyAISummary(
      messages,
      'system prompt',
    );

    expect(result.compressed).toBe(false);
    expect(result.savedTokens).toBe(0);
    // 原文一条不少、内容原样
    expect(result.messages).toHaveLength(messages.length);
    expect(result.messages.every((m, i) => m.content === messages[i].content)).toBe(true);
  });

  it('summary succeeds → still compresses normally', async () => {
    fallbackMocks.summarize.mockResolvedValue('compact summary');
    const compressor = new AutoContextCompressor({ preserveRecentCount: 2 });

    const result = await (compressor as unknown as CompressorInternals).applyAISummary(
      history(),
      'system prompt',
    );

    expect(result.compressed).toBe(true);
    expect(result.strategy).toBe('ai_summary');
  });
});
