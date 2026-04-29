import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePreviewItem } from '../../../src/shared/contract';
import { directionTokens } from '../../../src/design/direction-tokens';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: { workingDirectory: string | null }) => unknown) => {
    const state = { workingDirectory: null };
    return selector ? selector(state) : state;
  },
}));

import { QuestionFormPreview } from '../../../src/renderer/components/QuestionFormPreview';

describe('QuestionFormPreview', () => {
  it('renders direction cards with palette, font sample, and posture', () => {
    const item: WorkspacePreviewItem = {
      id: 'brief-form',
      kind: 'question_form',
      title: '设计 brief 收集',
      status: 'draft',
      createdAt: 1,
      source: { kind: 'message' },
      content: {
        json: JSON.stringify({
          surface: 'landing_page',
          direction: 'premium',
        }),
      },
    };

    const html = renderToStaticMarkup(React.createElement(QuestionFormPreview, { item }));

    expect(html).toContain('Premium');
    expect(html).toContain(directionTokens.premium.palette.primary);
    expect(html).toContain(directionTokens.premium.palette.contrast);
    expect(html).toContain('Design system sample');
    expect(html).toContain('中文字体样例');
    expect(html).toContain(directionTokens.premium.posture);
  });
});

