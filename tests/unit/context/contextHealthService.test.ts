// ============================================================================
// ContextHealthService - bySource.summary 摘要桶（N-CTXPANEL 病C）
// 反向变异承重：去掉 update() 里的 compaction 检测逻辑，这两个用例必须红。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompactionBlock } from '../../../src/shared/contract/message';
import { estimateTokens, estimateConversationTokens } from '../../../src/host/context/tokenEstimator';

vi.mock('../../../src/host/session/sessionStateManager', () => ({
  getSessionStateManager: () => ({ updateContextHealth: vi.fn() }),
}));

import { ContextHealthService, type ContextMessage } from '../../../src/host/context/contextHealthService';

const SUMMARY_CONTENT = '## Current State\n压缩前的对话摘要内容。';

function makeCompactionBlock(): CompactionBlock {
  return {
    type: 'compaction',
    content: SUMMARY_CONTENT,
    timestamp: 1,
    compactedMessageCount: 5,
    compactedTokenCount: 1000,
  };
}

describe('ContextHealthService — bySource.summary 摘要桶', () => {
  let service: ContextHealthService;

  beforeEach(() => {
    service = new ContextHealthService();
  });

  it('带 compaction 标记的消息计入 summary，conversation 被对应扣减', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: SUMMARY_CONTENT, compaction: makeCompactionBlock() },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];

    const health = service.update('s1', messages, '', 'kimi-k2.5');
    const bySource = health.breakdown.bySource!;

    const expectedSummary = estimateTokens(SUMMARY_CONTENT);
    const messagesTokens = estimateConversationTokens(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );

    expect(bySource.summary).toBe(expectedSummary);
    expect(bySource.summary).toBeGreaterThan(0);
    expect(bySource.conversation).toBe(Math.max(0, messagesTokens - expectedSummary));
    // 摘要 token 不再混进 conversation 桶
    expect(bySource.conversation).toBeLessThan(messagesTokens);
  });

  it('无 compaction 标记时 summary=0，conversation 维持原扣减法口径', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];

    const health = service.update('s2', messages, '', 'kimi-k2.5');
    const bySource = health.breakdown.bySource!;

    expect(bySource.summary).toBe(0);
    expect(bySource.conversation).toBe(
      estimateConversationTokens(messages.map((m) => ({ role: m.role, content: m.content }))),
    );
  });

  it('summary 与 conversation 是构成函数派生值：update() 全量重算，无带外写入口', () => {
    const health = service.update('s3', [{ role: 'user', content: 'hi' }], '', 'kimi-k2.5');
    // N-CTXCURRENT: bySource 每轮从消息重算（computeSourceBreakdown），
    // summary/conversation 不存在 record 写入路径；无摘要消息时 summary 恒为 0
    expect(health.breakdown.bySource!.summary).toBe(0);
    expect(health.breakdown.bySource!.conversation).toBeGreaterThan(0);
  });
});
