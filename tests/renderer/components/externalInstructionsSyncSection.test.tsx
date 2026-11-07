// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { ExternalInstructionsSyncSection } from '../../../src/renderer/components/features/settings/tabs/ExternalInstructionsSyncSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  invokeDomain.mockReset();
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => cleanup());

describe('ExternalInstructionsSyncSection', () => {
  it('unavailable: switch is disabled and asks for one manual import first', async () => {
    invokeDomain.mockResolvedValue({ mode: 'off', available: false, pending: [] });
    render(<ExternalInstructionsSyncSection />);

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(screen.getByTestId('external-instructions-sync-status').textContent)
      .toBe('请先手动导入一条 Codex 说明'));
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('external-instructions-sync-list')).toBeNull();
  });

  it('off: available switch enables sync but does not show pending rows', async () => {
    invokeDomain.mockImplementation(async (_domain: string, action: string) => (
      action === 'setInstructionsSync'
        ? { mode: 'on', available: true, pending: [] }
        : { mode: 'off', available: true, pending: [] }
    ));
    render(<ExternalInstructionsSyncSection />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('external-instructions-sync-status').textContent).toBe('未开启');
    fireEvent.click(toggle);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      expect.anything(),
      'setInstructionsSync',
      { mode: 'on' },
    ));
  });

  it('on: shows new rule texts, one-click import, and the one-time kept-Neo line without paths or hashes', async () => {
    const state = {
      mode: 'on',
      available: true,
      pending: [{
        instructionId: 'instruction:secret-hash',
        content: 'Always end with BLUEBIRD.',
        contentHash: 'secret-hash',
      }],
      lastRun: { at: 1, pending: 1, keptNeo: 1 },
    };
    invokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'confirmInstructionsSyncItem') {
        return { confirmation: { confirmed: true, imported: true }, state: { ...state, pending: [] } };
      }
      if (action === 'listImportHistory') return [];
      return state;
    });
    render(<ExternalInstructionsSyncSection />);

    expect(await screen.findByText('Always end with BLUEBIRD.')).toBeTruthy();
    expect(screen.getByTestId('external-instructions-sync-status').textContent).toBe('来源中有 1 条新说明');
    expect(screen.getByTestId('external-instructions-sync-kept-neo').textContent)
      .toBe('1 条说明保留了 Neo 中的版本');
    expect(document.body.textContent).not.toContain('secret-hash');
    expect(document.body.textContent).not.toContain('/.codex/');

    fireEvent.click(screen.getByText('导入这一条'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      expect.anything(),
      'confirmInstructionsSyncItem',
      { instructionId: 'instruction:secret-hash' },
    ));
    expect(await screen.findByText('已导入')).toBeTruthy();
  });
});
