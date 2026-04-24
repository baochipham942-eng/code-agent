import { describe, expect, it } from 'vitest';
import {
  buildReviewQueueFailureCapabilityAssetDraft,
  buildReviewQueueFailureCapabilityMetadata,
  buildReviewQueueItemId,
  buildSessionTraceIdentity,
  getReviewQueueFailureAssetStatusLabel,
  getReviewQueueFailureCapabilityLabel,
  isReviewQueueFailureCapabilityAssetStatus,
} from '../../../src/shared/contract/reviewQueue';

describe('review queue trace identity', () => {
  it('builds a stable session trace identity for replay and review', () => {
    const trace = buildSessionTraceIdentity('session-42');

    expect(trace).toEqual({
      traceId: 'session:session-42',
      source: 'session_replay',
      sessionId: 'session-42',
      replayKey: 'session-42',
    });
  });

  it('derives a deterministic review item id from the trace identity', () => {
    const trace = buildSessionTraceIdentity('session-42');

    expect(buildReviewQueueItemId(trace)).toBe('review:session:session-42');
    expect(buildReviewQueueItemId(trace)).toBe(buildReviewQueueItemId(buildSessionTraceIdentity('session-42')));
  });

  it.each([
    ['tool_error', 'capability_health', 'Capability Health · 工具失败'],
    ['env_failure', 'capability_health', 'Capability Health · 环境失败'],
    ['missing_context', 'dataset', 'Dataset · 缺少上下文'],
    ['hallucination', 'prompt_policy', 'Prompt Policy · 幻觉'],
    ['loop', 'prompt_policy', 'Prompt Policy · 循环卡住'],
    ['bad_decision', 'skill', 'Skill · 决策缺口'],
  ] as const)('routes %s failure attribution into %s follow-up metadata', (category, sink, label) => {
    const metadata = buildReviewQueueFailureCapabilityMetadata({
      rootCause: {
        stepIndex: 7,
        category,
        summary: 'failure summary',
        evidence: [7, 8],
        confidence: 0.82,
      },
    });

    expect(metadata).toEqual({
      sink,
      category,
      summary: 'failure summary',
      stepIndex: 7,
      confidence: 0.82,
      evidence: [7, 8],
    });
    expect(getReviewQueueFailureCapabilityLabel(metadata!)).toBe(label);
  });

  it('builds a draft asset from failure capability metadata', () => {
    const asset = buildReviewQueueFailureCapabilityAssetDraft({
      reviewItemId: 'review:session:session-42',
      sessionId: 'session-42',
      traceId: 'session:session-42',
      createdAt: 1_234,
      metadata: {
        sink: 'dataset',
        category: 'missing_context',
        summary: 'The model missed customer-specific constraints.',
        stepIndex: 3,
        confidence: 0.88,
        evidence: [3, 4],
      },
    });

    expect(asset).toEqual({
      id: 'failure-asset:review:session:session-42',
      reviewItemId: 'review:session:session-42',
      sessionId: 'session-42',
      traceId: 'session:session-42',
      status: 'draft',
      sink: 'dataset',
      category: 'missing_context',
      title: 'Dataset · 缺少上下文 draft',
      body: [
        'The model missed customer-specific constraints.',
        'Target: Dataset',
        'Category: 缺少上下文',
        'Root step: 3',
        'Confidence: 88%',
        'Evidence steps: 3, 4',
      ].join('\n'),
      stepIndex: 3,
      confidence: 0.88,
      evidence: [3, 4],
      createdAt: 1_234,
      updatedAt: 1_234,
    });
  });

  it('labels and validates failure asset statuses', () => {
    expect(getReviewQueueFailureAssetStatusLabel('draft')).toBe('草稿');
    expect(getReviewQueueFailureAssetStatusLabel('ready')).toBe('待应用');
    expect(getReviewQueueFailureAssetStatusLabel('applied')).toBe('已应用');
    expect(getReviewQueueFailureAssetStatusLabel('dismissed')).toBe('已忽略');
    expect(isReviewQueueFailureCapabilityAssetStatus('ready')).toBe(true);
    expect(isReviewQueueFailureCapabilityAssetStatus('unknown')).toBe(false);
  });
});
