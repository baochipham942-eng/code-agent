// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { publishGlobalHotkeyRegistrationResults } from '../../../src/renderer/services/globalHotkeyRegistration';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn(() => vi.fn()) },
}));

import { KeybindingsSettings } from '../../../src/renderer/components/features/settings/tabs/KeybindingsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

type ActionCase = {
  id: 'voice.toggle' | 'voice.callToggle' | 'computerUse.open';
  label: string;
  present: boolean;
  expectation: 'shown' | 'hidden';
};

const CASES: ActionCase[] = [
  { id: 'voice.toggle', label: '语音输入', present: false, expectation: 'hidden' },
  { id: 'voice.toggle', label: '语音输入', present: true, expectation: 'shown' },
  { id: 'voice.callToggle', label: '拨打/挂断实时通话', present: false, expectation: 'hidden' },
  { id: 'voice.callToggle', label: '拨打/挂断实时通话', present: true, expectation: 'shown' },
  { id: 'computerUse.open', label: '打开 Computer Use', present: false, expectation: 'hidden' },
  { id: 'computerUse.open', label: '打开 Computer Use', present: true, expectation: 'shown' },
];

function cuaDriverState(enabled: boolean) {
  return [{
    config: { name: 'cua-driver', type: 'in-process' as const, enabled },
    status: 'connected' as const,
    toolCount: 0,
    resourceCount: 0,
  }];
}

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(undefined);
  publishGlobalHotkeyRegistrationResults([]);
  useAppStore.setState({ language: 'zh' });
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
  });
});

afterEach(() => {
  publishGlobalHotkeyRegistrationResults([]);
  cleanup();
});

describe('KeybindingsSettings capability filter', () => {
  it.each(CASES)('$id is $expectation', async ({ id, label, present }) => {
    useBundledCapabilityStore.setState({
      installed: {
        'builtin.voice-input': id === 'voice.toggle' && present,
        'builtin.voice-live': id === 'voice.callToggle' && present,
      },
    });
    invokeDomain.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.MCP && action === 'getServerStates') {
        return id === 'computerUse.open' && present ? cuaDriverState(true) : [];
      }
      return undefined;
    });

    render(<KeybindingsSettings />);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.MCP, 'getServerStates');
    });

    if (present) {
      expect(await screen.findByText(label)).toBeTruthy();
    } else {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
