// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { SuggestionBar } from '../../../src/renderer/components/features/chat/ChatInput/SuggestionBar';

const suggestions = [
  { id: 'one', text: '继续深挖第一点', source: 'context' },
  { id: 'two', text: '用一个产品案例说明', source: 'context' },
];

afterEach(cleanup);

describe('SuggestionBar turn outcome gate', () => {
  it.each(['error', 'interrupted'] as const)(
    'does not render follow-up chips after a failed/cancelled turn (%s)',
    (lastTurnStatus) => {
      render(
        <SuggestionBar
          suggestions={suggestions}
          onSelect={vi.fn()}
          lastTurnStatus={lastTurnStatus}
        />,
      );

      expect(screen.queryByText('继续深挖第一点')).toBeNull();
      expect(screen.queryByText('用一个产品案例说明')).toBeNull();
    },
  );

  it('renders the same chips after a normally completed turn', () => {
    render(
      <SuggestionBar
        suggestions={suggestions}
        onSelect={vi.fn()}
        lastTurnStatus="completed"
      />,
    );

    expect(screen.getByText('继续深挖第一点')).toBeTruthy();
    expect(screen.getByText('用一个产品案例说明')).toBeTruthy();
  });
});
