import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplayAnalyticsSidebar } from '../../../src/renderer/components/features/evalCenter/ReplayAnalyticsSidebar';

describe('ReplayAnalyticsSidebar failure follow-up', () => {
  it('renders a failure follow-up sink when replay has failure attribution', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReplayAnalyticsSidebar, {
        summary: {
          totalTurns: 2,
          toolDistribution: { Read: 1, Edit: 0 },
          thinkingRatio: 0.2,
          selfRepairChains: 0,
          totalDurationMs: 1200,
          deviations: [],
          failureAttribution: {
            rootCause: {
              stepIndex: 3,
              category: 'missing_context',
              summary: '关键上下文没有带入，导致后续判断失真。',
              evidence: [3, 4],
              confidence: 0.86,
            },
            causalChain: [
              { stepIndex: 3, role: 'root', note: '缺少失败现场' },
              { stepIndex: 4, role: 'terminal', note: '错误结论被直接输出' },
            ],
            relatedRegressionCases: [],
            llmUsed: false,
            durationMs: 8,
          },
        },
        objective: null,
        failureFollowupState: 'available',
        onEnqueueFailureFollowup: vi.fn(),
      }),
    );

    expect(html).toContain('Failure Follow-up');
    expect(html).toContain('关键上下文没有带入');
    expect(html).toContain('分流 Dataset · 缺少上下文');
    expect(html).toContain('加入 Failure Follow-up');
    expect(html).toContain('会写入 Review Queue');
  });

  it('shows queued state when the session is already marked as failure follow-up', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReplayAnalyticsSidebar, {
        summary: {
          totalTurns: 1,
          toolDistribution: {},
          thinkingRatio: 0,
          selfRepairChains: 0,
          totalDurationMs: 0,
          deviations: [{
            stepIndex: 1,
            type: 'loop',
            description: '同一操作重复执行。',
            severity: 'medium',
          }],
        },
        objective: null,
        failureFollowupState: 'queued',
        onEnqueueFailureFollowup: vi.fn(),
      }),
    );

    expect(html).toContain('已在 Failure Follow-up');
  });
});
