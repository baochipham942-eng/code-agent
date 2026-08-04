// @vitest-environment jsdom
// ============================================================================
// E2 · TurnDiffSummary 文件名点击 → openPreview；箭头点击 → 展开 diff
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';

const openPreview = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn().mockResolvedValue([]),
    invokeDomain: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (s: { openPreview: typeof openPreview }) => unknown) =>
    selector({ openPreview }),
}));

import { TurnDiffSummary } from '../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary';
import { clearTurnDiffExpansionForTests } from '../../../src/renderer/utils/turnDiffExpansionState';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeTurn(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-preview-1',
    status: 'completed',
    startTime: 100,
    endTime: 200,
    nodes: [
      {
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 150,
        toolCall: {
          id: 'tool-1',
          name: 'Write',
          args: {
            file_path: '/Users/me/project/artifacts/overview-batch2-note.md',
            content: 'hello',
          },
          result: 'Created file',
          success: true,
        },
      },
    ],
  } as TraceTurn;
}

beforeEach(() => {
  openPreview.mockReset();
  clearTurnDiffExpansionForTests();
  useSessionStore.setState({
    currentSessionId: 'session-1',
    sessions: [
      {
        id: 'session-1',
        workingDirectory: '/Users/me/project',
      } as never,
    ],
  });
});

afterEach(cleanup);

describe('TurnDiffSummary — file name opens preview, chevron expands diff', () => {
  it('clicking the file name routes to openPreview with the full path', () => {
    render(<TurnDiffSummary turn={makeTurn()} />);
    const nameBtn = screen.getByRole('button', { name: /overview-batch2-note\.md/i });
    fireEvent.click(nameBtn);
    expect(openPreview).toHaveBeenCalledWith(
      '/Users/me/project/artifacts/overview-batch2-note.md',
    );
  });

  it('clicking the expand chevron toggles diff without openPreview', () => {
    render(<TurnDiffSummary turn={makeTurn()} />);
    const expandBtn = screen.getByRole('button', { name: /展开改动|收起改动|expand|collapse/i });
    // aria-expanded starts false
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expandBtn);
    expect(expandBtn.getAttribute('aria-expanded')).toBe('true');
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('path title exposes the full absolute path for hover', () => {
    render(<TurnDiffSummary turn={makeTurn()} />);
    const nameBtn = screen.getByRole('button', { name: /overview-batch2-note\.md/i });
    expect(nameBtn.getAttribute('title')).toBe(
      '/Users/me/project/artifacts/overview-batch2-note.md',
    );
  });
});
