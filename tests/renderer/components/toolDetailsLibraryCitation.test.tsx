// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { Citation } from '../../../src/shared/contract/citation';

const projectLibraryEvidence = vi.fn();
const copyPathToClipboard = vi.fn();

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { openPreview: () => void; openSettingsTab: () => void }) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  projectLibraryEvidence: (...args: unknown[]) => projectLibraryEvidence(...args),
}));

vi.mock('../../../src/renderer/utils/platform', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/utils/platform')>(
    '../../../src/renderer/utils/platform',
  );
  return {
    ...actual,
    isWebMode: () => true,
    isTauriMode: () => false,
    copyPathToClipboard: (...args: unknown[]) => copyPathToClipboard(...args),
  };
});

import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

function citation(partial: Partial<Citation> & Pick<Citation, 'id' | 'type' | 'source' | 'label'>): Citation {
  return {
    toolCallId: 'call-1',
    timestamp: 1,
    ...partial,
  };
}

function toolCallWith(citations: Citation[]): ToolCall {
  return {
    id: 'call-1',
    name: 'Read',
    arguments: { file_path: '/tmp/a.md' },
    result: {
      success: true,
      output: 'ok',
      metadata: { citations },
    },
  };
}

describe('ToolDetails library citations', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('cell citation without a line anchor does not project library evidence', async () => {
    render(<ToolDetails toolCall={toolCallWith([
      citation({ id: 'c-cell', type: 'cell', source: '/tmp/sheet.xlsx', label: 'B15' }),
    ])} />);

    screen.getByText('B15').click();
    await waitFor(() => {
      expect(projectLibraryEvidence).not.toHaveBeenCalled();
    });
  });

  it('URL citation keeps window.open and does not project library evidence', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ToolDetails toolCall={toolCallWith([
      citation({ id: 'c-url', type: 'url', source: 'https://example.com/doc', label: 'example' }),
    ])} />);

    screen.getByText('example').click();
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith('https://example.com/doc', '_blank', 'noopener,noreferrer');
    });
    expect(projectLibraryEvidence).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('file citation miss falls back to default open and does not keep a stale drawer', async () => {
    projectLibraryEvidence.mockResolvedValue({
      query: { source: '/tmp/a.md' },
      hit: false,
      reason: '未找到对应的资料库条目',
    });
    render(<ToolDetails toolCall={toolCallWith([
      citation({ id: 'c-file', type: 'file', source: '/tmp/a.md', label: 'a.md', location: 'line:1' }),
    ])} />);

    screen.getByText('a.md').click();
    await waitFor(() => {
      expect(projectLibraryEvidence).toHaveBeenCalled();
      expect(copyPathToClipboard).toHaveBeenCalledWith('/tmp/a.md');
    });
    expect(screen.queryByText('资料依据')).toBeNull();
  });

  it('file citation hit opens the evidence drawer', async () => {
    projectLibraryEvidence.mockResolvedValue({
      query: { source: '/tmp/a.md', location: 'line:1' },
      hit: true,
      fragment: { startLine: 1, endLine: 1, totalLines: 1, text: '命中片段' },
      item: { id: 'lib_1', title: 'a.md' },
    });
    render(<ToolDetails toolCall={toolCallWith([
      citation({ id: 'c-hit', type: 'file', source: '/tmp/a.md', label: 'a.md', location: 'line:1' }),
    ])} />);

    screen.getByText('a.md').click();
    await waitFor(() => {
      expect(screen.getByText('命中片段')).toBeTruthy();
    });
    expect(copyPathToClipboard).not.toHaveBeenCalled();
  });

  it('evidence IPC failure shows an error instead of rejecting', async () => {
    projectLibraryEvidence.mockRejectedValue(new Error('IPC down'));
    render(<ToolDetails toolCall={toolCallWith([
      citation({ id: 'c-err', type: 'file', source: '/tmp/a.md', label: 'a.md', location: 'line:1' }),
    ])} />);

    screen.getByText('a.md').click();
    await waitFor(() => {
      expect(screen.getByText(/IPC down/)).toBeTruthy();
    });
  });
});
