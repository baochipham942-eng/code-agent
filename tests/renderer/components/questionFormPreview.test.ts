import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePreviewItem } from '../../../src/shared/contract';
import { directionTokens } from '../../../src/design/direction-tokens';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      workingDirectory: null,
      language: 'zh' as const,
      cloudUIStrings: undefined,
      setLanguage: () => {},
    };
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

  it('renders direction refs on the card', () => {
    const item: WorkspacePreviewItem = {
      id: 'brief-refs',
      kind: 'question_form',
      title: 'brief',
      status: 'draft',
      createdAt: 1,
      source: { kind: 'message' },
      content: { json: JSON.stringify({ surface: 'landing_page', direction: 'premium' }) },
    };
    const html = renderToStaticMarkup(React.createElement(QuestionFormPreview, { item }));
    for (const ref of directionTokens.premium.refs) {
      expect(html).toContain(ref);
    }
  });

  it('curates to only the AI-picked directions when provided', () => {
    const item: WorkspacePreviewItem = {
      id: 'brief-curated',
      kind: 'question_form',
      title: 'brief',
      status: 'draft',
      createdAt: 1,
      source: { kind: 'message' },
      content: {
        json: JSON.stringify({ surface: 'app_screen', directions: ['premium', 'calm', 'technical'] }),
      },
    };
    const html = renderToStaticMarkup(React.createElement(QuestionFormPreview, { item }));
    expect(html).toContain('Premium');
    expect(html).toContain('Calm');
    expect(html).toContain('Technical');
    // Non-curated directions must not render.
    expect(html).not.toContain('Playful');
    expect(html).not.toContain('Editorial');
  });

  it('renders the escape hatch and reference-screenshot mode toggle', () => {
    const item: WorkspacePreviewItem = {
      id: 'brief-modes',
      kind: 'question_form',
      title: 'brief',
      status: 'draft',
      createdAt: 1,
      source: { kind: 'message' },
      content: { json: JSON.stringify({ surface: 'landing_page', direction: 'premium' }) },
    };
    const html = renderToStaticMarkup(React.createElement(QuestionFormPreview, { item }));
    expect(html).toContain('直接生成');
    expect(html).toContain('匹配参考截图');
  });

  it('shows reference-screenshot guidance when the form is in reference mode', () => {
    const item: WorkspacePreviewItem = {
      id: 'brief-ref-mode',
      kind: 'question_form',
      title: 'brief',
      status: 'draft',
      createdAt: 1,
      source: { kind: 'message' },
      content: { json: JSON.stringify({ surface: 'landing_page', referenceScreenshot: true }) },
    };
    const html = renderToStaticMarkup(React.createElement(QuestionFormPreview, { item }));
    // Reference mode hides direction cards (no posture text) and shows the hint.
    expect(html).not.toContain(directionTokens.premium.posture);
    expect(html).toContain('提取配色');
  });
});

