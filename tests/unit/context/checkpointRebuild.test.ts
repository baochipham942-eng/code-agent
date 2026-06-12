import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { renderCheckpointRebuildContext } from '../../../src/main/context/checkpoint';
import { estimateTokens } from '../../../src/main/context/tokenEstimator';

function message(id: string, content: string): Message {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 1,
  } as Message;
}

describe('renderCheckpointRebuildContext token cap (audit C-M3)', () => {
  it('caps an oversized first tail message instead of blowing the budget', () => {
    const huge = message('m1', 'x '.repeat(60_000)); // ~60K tokens
    const rendered = renderCheckpointRebuildContext({
      checkpoint: '# Session Checkpoint\n(short)',
      memory: '# Project Memory\n(short)',
      tailMessages: [huge, message('m2', 'small follow-up')],
      maxTokens: 24_000,
    });
    // 首条消息不能无条件放行：渲染结果必须收敛在预算内（留 10% 容差给框架文本）
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(24_000 * 1.1);
    expect(rendered).toContain('[truncated by checkpoint rebuild token cap]');
  });

  it('keeps small tail messages untouched', () => {
    const rendered = renderCheckpointRebuildContext({
      checkpoint: '# Session Checkpoint\n(short)',
      memory: '# Project Memory\n(short)',
      tailMessages: [message('m1', 'first'), message('m2', 'second')],
      maxTokens: 24_000,
    });
    expect(rendered).toContain('first');
    expect(rendered).toContain('second');
    expect(rendered).not.toContain('[truncated by checkpoint rebuild token cap]');
  });
});
