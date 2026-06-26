import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoalNoticeMessage } from '../../../src/renderer/components/features/chat/MessageBubble/GoalNoticeMessage';
import { encodeGoalNotice } from '../../../src/renderer/components/features/chat/goalNotice';

describe('GoalNoticeMessage', () => {
  it('renders verification card counts and evidence refs in the completion notice', () => {
    const html = renderToStaticMarkup(
      React.createElement(GoalNoticeMessage, {
        content: encodeGoalNotice({
          kind: 'met',
          goal: 'ship verification card',
          turns: 2,
          tokensUsed: 1234,
          verificationCard: {
            status: 'failed',
            failureType: 'test',
            summary: 'test: npm test exited 1.',
            counts: { passed: 1, failed: 1, notRun: 1, total: 3 },
            requiredStatus: 'failed',
            commands: [],
            evidenceRefIds: ['evidence_a', 'evidence_b', 'evidence_c', 'evidence_d'],
            skippedChecks: [],
          },
        }),
      }),
    );

    expect(html).toContain('pass 1');
    expect(html).toContain('fail 1');
    expect(html).toContain('not_run 1');
    expect(html).toContain('required failed');
    expect(html).toContain('test: npm test exited 1.');
    expect(html).toContain('refs evidence_a, evidence_b, evidence_c +1');
  });
});
