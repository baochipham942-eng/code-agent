// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

vi.mock('../../../src/renderer/slots/thirdPartyPluginUiLoader', () => ({
  refreshThirdPartyPluginUi: vi.fn(async () => undefined),
}));

import { ShellOverlaySlotHost } from '../../../src/renderer/slots/productSlotHosts';

const pending = {
  token: 'approval-request-1',
  id: 'global-approval-plugin',
  packageId: '1.0.0-fixture',
  mode: 'run' as const,
  approvalRequired: true,
  name: '全局审批插件',
  version: '1.0.0',
  description: '没有打开会话时也要能够处理',
  permissions: [],
  toolNames: [],
  surface: 'ui' as const,
  sourceKind: 'zip' as const,
  sourceLabel: 'fixture.zip',
  sourceTrust: { level: 'signed' as const, reason: 'fixture' },
  requestedUiSlots: ['settings.section'],
  sandbox: { passed: true as const, summary: '检查完成' },
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_APPROVAL_LIST) {
      return { success: true, data: [pending] };
    }
    return { success: true, data: undefined };
  });
});

afterEach(() => cleanup());

describe('framework plugin approval overlay', () => {
  it('V12 remains reachable through the app-level overlay with no conversation mounted', async () => {
    render(<ShellOverlaySlotHost />);

    const dialog = await screen.findByRole('dialog', { name: '允许这个插件运行？' });
    expect(dialog.closest('[data-plugin-slot-host="shell.overlay"]')).toBeTruthy();
    expect(screen.getByText('没有打开会话时也要能够处理')).toBeTruthy();
  });

  it('sends one-version approval without granting later versions', async () => {
    render(<ShellOverlaySlotHost />);
    fireEvent.click(await screen.findByRole('button', { name: '仅允许这个版本' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM,
      pending.token,
      false,
    ));
  });

  it('sends future-version approval only from the explicit second choice', async () => {
    render(<ShellOverlaySlotHost />);
    fireEvent.click(await screen.findByRole('button', { name: '也允许今后的版本' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM,
      pending.token,
      true,
    ));
  });
});
