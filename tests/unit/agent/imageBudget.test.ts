import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract/message';
import type { ContextTranscriptEntry } from '../../../src/host/agent/runtime/contextAssembly/shared';
import {
  applyHistoricalImageBudget,
} from '../../../src/host/agent/runtime/contextAssembly/imageBudget';

function image(id: string, dataBytes = 700): MessageAttachment {
  return {
    id,
    type: 'image',
    category: 'image',
    name: `${id}.png`,
    size: dataBytes,
    mimeType: 'image/png',
    data: 'a'.repeat(dataBytes),
  };
}

function entry(id: string, turnIndex: number, attachments: MessageAttachment[]): ContextTranscriptEntry {
  return {
    id,
    originMessageId: id,
    role: 'user',
    content: `turn ${turnIndex}`,
    timestamp: turnIndex,
    turnIndex,
    attachments,
  };
}

describe('historical image request budget', () => {
  it('enforces count and request-byte budgets newest-first while preserving the current turn', () => {
    const entries = [
      entry('old-1', 1, [image('old-1-image')]),
      entry('old-2', 2, [image('old-2-image')]),
      entry('old-3', 3, [image('old-3-image')]),
      entry('current', 4, [image('current-image')]),
    ];

    const result = applyHistoricalImageBudget(entries, {
      modelConfig: { provider: 'claude', model: 'claude-sonnet', protocol: 'claude' },
      currentUserMessageId: 'current',
      locale: 'en',
      budgetOverride: { maxImages: 3, maxRequestBytes: 2_400, reservedRequestBytes: 0 },
    });

    const keptIds = result.entries.flatMap((message) => message.attachments?.map((item) => item.id) ?? []);
    expect(keptIds).toContain('current-image');
    expect(keptIds).toContain('old-3-image');
    expect(keptIds).not.toContain('old-1-image');
    expect(result.keptImages).toBeLessThanOrEqual(result.budget.maxImages);
    expect(result.estimatedRequestBytes).toBeLessThanOrEqual(result.budget.maxRequestBytes);
    expect(result.omittedImages).toBeGreaterThan(0);
    expect(result.entries[0].content).toContain('omitted from this model request');
    expect(entries[0].attachments).toHaveLength(1);
  });

  it('localizes omission copy and resolves routed provider families', () => {
    const result = applyHistoricalImageBudget([
      entry('old', 1, [image('old-image')]),
      entry('current', 2, [image('current-image')]),
    ], {
      modelConfig: { provider: 'gemini', model: 'gemini-2.5-flash' },
      currentUserMessageId: 'current',
      locale: 'zh',
      budgetOverride: { maxImages: 1, maxRequestBytes: 10_000, reservedRequestBytes: 0 },
    });

    expect(result.entries[0].content).toContain('已省略 1 张较早的历史图片');
    expect(applyHistoricalImageBudget([], { modelConfig: { provider: 'openrouter', model: 'anthropic/claude-sonnet' }, locale: 'zh' }).family).toBe('anthropic');
    expect(applyHistoricalImageBudget([], { modelConfig: { provider: 'openrouter', model: 'google/gemini-2.5-pro' }, locale: 'zh' }).family).toBe('gemini');
    expect(applyHistoricalImageBudget([], { modelConfig: { provider: 'openai', model: 'gpt-5' }, locale: 'zh' }).family).toBe('openai');
  });
});
