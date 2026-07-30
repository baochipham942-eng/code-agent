// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { McpServerEditor } from '../../../src/renderer/components/features/settings/McpServerEditor';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

afterEach(() => cleanup());

describe('McpServerEditor install cancellation', () => {
  it('returns installing → cancelling → idle on a narrow slow connection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    let finishInstall!: (outcome: 'cancelled') => void;
    const onSave = vi.fn(() => new Promise<'cancelled'>((resolve) => {
      finishInstall = resolve;
    }));
    const onCancelInstall = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <McpServerEditor
        isOpen
        onClose={onClose}
        onSave={onSave}
        onCancelInstall={onCancelInstall}
        initialConfig={{ name: 'slow-server', type: 'http', url: 'https://example.com/mcp' }}
      />,
    );

    fireEvent.click(screen.getByText(zh.settings.mcp.editor.save));
    expect(await screen.findByText(zh.settings.mcp.editor.installing)).toBeTruthy();
    fireEvent.click(screen.getByText(zh.settings.mcp.editor.cancelInstall));
    expect(screen.getByText(zh.settings.mcp.editor.cancelling)).toBeTruthy();
    expect(onCancelInstall).toHaveBeenCalledWith('slow-server');

    finishInstall('cancelled');
    await waitFor(() => expect(screen.getByText(zh.settings.mcp.editor.save)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});
