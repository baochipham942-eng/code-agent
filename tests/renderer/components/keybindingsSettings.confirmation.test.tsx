// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { publishGlobalHotkeyRegistrationResults } from '../../../src/renderer/services/globalHotkeyRegistration';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

import { KeybindingsSettings } from '../../../src/renderer/components/features/settings/tabs/KeybindingsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(undefined);
  publishGlobalHotkeyRegistrationResults([]);
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  publishGlobalHotkeyRegistrationResults([]);
  cleanup();
});

describe('KeybindingsSettings restore-all confirmation', () => {
  it('persists all defaults only after confirmation', async () => {
    render(<KeybindingsSettings />);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'get');
    });
    invokeDomain.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复全部默认' }));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        expect.objectContaining({ keybindings: expect.any(Object) }),
      );
    });
  });

  it('keeps single-shortcut reset immediate', async () => {
    render(<KeybindingsSettings />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalled());
    invokeDomain.mockClear();

    fireEvent.click(screen.getAllByTitle('恢复该项默认')[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        expect.objectContaining({ keybindings: expect.any(Object) }),
      );
    });
  });

  it('shows a matching native registration failure on the binding row', async () => {
    invokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action !== 'get') return undefined;
      return {
        keybindings: {
          version: 1,
          globalHotkeysEnabled: true,
          bindings: {
            'voice.callToggle': { enabled: true, accelerator: 'Cmd+Alt+R' },
          },
        },
      };
    });

    render(<KeybindingsSettings />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'get'));

    act(() => {
      publishGlobalHotkeyRegistrationResults([{
        actionId: 'voice.callToggle',
        accelerator: 'Cmd+Alt+R',
        registered: false,
        error: 'hotkey already registered',
      }]);
    });

    const error = await screen.findByTestId('keybinding-registration-error-voice.callToggle');
    expect(error.textContent).toContain('注册失败：hotkey already registered');
  });
});
