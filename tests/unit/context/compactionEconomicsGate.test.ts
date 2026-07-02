import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { COMPACTION_ECONOMICS } from '../../../src/shared/constants';

// WP2-3 净节省经济学闸：省下 tokens − 压缩调用成本×权重 ≥ 阈值才提交（仅自动触发源）。
// 现有校验管质量，这个闸管经济学——防止打掉 prefix cache 换来微不足道的节省。

const gateMocks = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  summarizeWithMetadata: vi.fn(),
}));

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarize: vi.fn(async () => 'summary'),
  compactModelSummarizeWithMetadata: gateMocks.summarizeWithMetadata,
}));

vi.mock('../../../src/host/context/compactionAuditRecorder', () => ({
  recordCompactionAuditSnapshot: gateMocks.recordAudit,
}));

import { compactMessagesWithSummary } from '../../../src/host/context/compactionService';

// 覆盖全部 8 个必需 section + 显式 Needs Re-read，避免校验修复分支干扰经济学断言
const VALID_SUMMARY = [
  '# Context Handoff',
  '## Current State', 'Work in progress.',
  '## Files And Changes', 'None.',
  '## Commands And Evidence', 'None.',
  '## Errors And Resolutions', 'None.',
  '## User Preferences And Constraints', 'None.',
  '## Open Work', 'None.',
  '## Continue From Here', 'Continue.',
  '## Needs Re-read', 'None.',
].join('\n');

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Number(id.replace(/\D/g, '') || 1) };
}

/** originalTokens 大：长历史，压缩净节省远超阈值 */
function longMessages(): Message[] {
  return [
    message('m1', 'user', 'Analyze the data pipeline. '.repeat(400)),
    message('m2', 'assistant', 'Here is the detailed analysis of everything. '.repeat(400)),
    message('m3', 'assistant', 'More long-form intermediate output follows here. '.repeat(400)),
    message('m4', 'assistant', 'recent answer'),
  ];
}

/** originalTokens 小：压缩注定不划算 */
function shortMessages(): Message[] {
  return [
    message('m1', 'user', 'hi'),
    message('m2', 'assistant', 'hello'),
    message('m3', 'assistant', 'short note'),
    message('m4', 'assistant', 'recent answer'),
  ];
}

describe('compaction net-savings gate (WP2-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateMocks.summarizeWithMetadata.mockResolvedValue({
      summary: VALID_SUMMARY,
      metadata: { provider: 'zhipu', model: 'glm-4.7-flash', useMainModel: false },
    });
  });

  it('auto_threshold + tiny history → rejected with net_savings_below_threshold, no model call', async () => {
    const result = await compactMessagesWithSummary({
      sessionId: 's-gate-small',
      source: 'auto_threshold',
      messages: shortMessages(),
      preserveRecentCount: 1,
    });
    expect(result.success).toBe(false);
    expect(result.reason).toBe('net_savings_below_threshold');
    // 预闸：注定不划算时连摘要调用都不发（省下这笔付费调用）
    expect(gateMocks.summarizeWithMetadata).not.toHaveBeenCalled();
    // 决策进 audit
    expect(gateMocks.recordAudit).toHaveBeenCalled();
  });

  it('auto_threshold + long history → net savings clear the gate, compaction commits', async () => {
    const result = await compactMessagesWithSummary({
      sessionId: 's-gate-large',
      source: 'auto_threshold',
      messages: longMessages(),
      preserveRecentCount: 1,
    });
    expect(result.success).toBe(true);
    expect(result.netSavings).toBeDefined();
    expect(result.netSavings!.netSavedTokens).toBeGreaterThanOrEqual(
      COMPACTION_ECONOMICS.MIN_NET_SAVINGS_TOKENS,
    );
    expect(result.netSavings!.callCostTokens).toBeGreaterThan(0);
  });

  it('manual source bypasses the economics gate even for tiny history', async () => {
    const result = await compactMessagesWithSummary({
      sessionId: 's-gate-manual',
      source: 'manual_current',
      messages: shortMessages(),
      preserveRecentCount: 1,
    });
    // 用户手动压缩 = 明确意图，不被经济学闸拦（可能因 summary_not_smaller 失败，但不因净节省闸）
    expect(result.reason).not.toBe('net_savings_below_threshold');
    expect(gateMocks.summarizeWithMetadata).toHaveBeenCalled();
  });

  it('overflow_recovery bypasses the gate (must compress regardless of economics)', async () => {
    const result = await compactMessagesWithSummary({
      sessionId: 's-gate-overflow',
      source: 'overflow_recovery',
      messages: shortMessages(),
      preserveRecentCount: 1,
    });
    expect(result.reason).not.toBe('net_savings_below_threshold');
  });
});
