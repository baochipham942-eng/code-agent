import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoalComposerCard } from '../../../src/renderer/components/features/chat/ChatInput/GoalComposerCard';

describe('GoalComposerCard', () => {
  it('renders the goal contract fields and disabled start button by default', () => {
    const html = renderToStaticMarkup(
      <GoalComposerCard
        submitting={false}
        onSubmit={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain('data-goal-composer');
    expect(html).toContain('目标合同');
    expect(html).toContain('data-goal-field="goal"');
    expect(html).toContain('data-goal-field="verify"');
    expect(html).toContain('data-goal-field="acceptance"');
    expect(html).toContain('data-goal-field="boundaries"');
    expect(html).toContain('data-goal-field="pause"');
    expect(html).toContain('data-goal-start');
    expect(html).toContain('disabled=""');
  });
});
