// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_LIMITS, COMPANION_MANAGE_CHANNEL } from '../../../src/shared/constants/companion';
import { companionErrorCopy, companionText } from '../../../src/renderer/i18n/companion';
import { deriveInvitationVerify, formatInvitationVerify } from '../../../src/shared/companion/lanProtocol';
import type { CompanionManagementResult } from '../../../src/shared/contract/companionManagement';

const invoke = vi.hoisted(() => vi.fn());
const toDataURL = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,qr'));
const setShowAuthModal = vi.hoisted(() => vi.fn());
// 可变语言态：总闸弹窗文案要 zh/en 都验；t 只给 ConfirmDialog→Modal 关闭按钮需要的最小真形状。
const i18nState = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  t: { common: { close: '关闭', cancel: '取消', confirm: '确认' } },
}));
// 极简 zustand 形状的 authStore 替身：selector hook，但登录态变化要能真触发组件重渲染。
const authMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const api = {
    state: { isAuthenticated: false, setShowAuthModal } as { isAuthenticated: boolean; setShowAuthModal: (show: boolean) => void },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => api.state,
    setAuthenticated(isAuthenticated: boolean) {
      api.state = { ...api.state, isAuthenticated };
      for (const listener of [...listeners]) listener();
    },
    reset() { api.state = { isAuthenticated: false, setShowAuthModal }; },
  };
  return api;
});

vi.mock('../../../src/renderer/services/ipcService', () => ({ invoke }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => i18nState }));
vi.mock('qrcode', () => ({ default: { toDataURL } }));
vi.mock('../../../src/renderer/stores/authStore', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAuthStore: (selector: (state: { isAuthenticated: boolean; setShowAuthModal: (show: boolean) => void }) => unknown) =>
      selector(useSyncExternalStore(authMock.subscribe, authMock.getSnapshot)),
  };
});

import { CompanionSection } from '../../../src/renderer/components/features/settings/sections/CompanionSection';

const text = companionText.zh;

function invitation(): Extract<CompanionManagementResult, { kind: 'invitation' }> {
  return {
    kind: 'invitation',
    invitation: {
      version: 1, endpoint: 'http://192.168.1.2:8182', inviteId: '123e4567-e89b-12d3-a456-426614174000',
      psk: 'aa'.repeat(32), hostKey: 'bb'.repeat(32), expiresAt: Date.now() + 120_000,
    },
  };
}

function status(overrides: Partial<Extract<CompanionManagementResult, { kind: 'status' }>> = {}): CompanionManagementResult {
  return {
    kind: 'status',
    sessions: [{ id: 's1', title: 'Talk' }],
    projects: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }],
    devices: [],
    ...overrides,
  };
}

function mockManage(result: CompanionManagementResult | ((req: { action: string; scope?: string[] }) => CompanionManagementResult | Promise<CompanionManagementResult>)) {
  invoke.mockImplementation(async (_channel: string, request: { action: string; scope?: string[] }) => {
    return typeof result === 'function' ? result(request) : request.action === 'status' ? result : invitation();
  });
}

describe('CompanionSection pairing UI', () => {
  afterEach(() => { cleanup(); invoke.mockReset(); toDataURL.mockClear(); authMock.reset(); });
  beforeEach(() => { mockManage(status()); });

  it('zh/en keys stay paired', () => {
    expect(Object.keys(companionText.zh).sort()).toEqual(Object.keys(companionText.en).sort());
  });

  it('invites every current project and has no session checkboxes', async () => {
    render(<CompanionSection />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(COMPANION_MANAGE_CHANNEL, { action: 'status' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: text.create }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(COMPANION_MANAGE_CHANNEL, {
      action: 'invite', scope: ['project:one', 'project:two'],
    }));
    expect(await screen.findByAltText(text.qr)).toBeTruthy();
    expect(screen.getByText(text.scanHint)).toBeTruthy();
    expect(screen.getByText(text.expires)).toBeTruthy();
    expect(screen.getByText(text.awayHint)).toBeTruthy();
    expect(screen.queryByTestId('companion-verify')).toBeNull();
  });

  it('shows the grouped check code next to the QR when the invitation carries verify', async () => {
    const issued = invitation();
    issued.invitation.verify = deriveInvitationVerify(issued.invitation.psk, issued.invitation.hostKey);
    invoke.mockImplementation(async (_channel: string, request: { action: string }) => (
      request.action === 'status' ? status() : issued
    ));
    render(<CompanionSection />);
    fireEvent.click(await screen.findByRole('button', { name: text.create }));
    expect((await screen.findByTestId('companion-verify')).textContent).toBe(
      formatInvitationVerify(issued.invitation.verify!),
    );
    expect(screen.getByText(text.verifyLabel)).toBeTruthy();
  });

  it('still invites when there are more projects than one invite can cover', async () => {
    const extra = Array.from({ length: COMPANION_LIMITS.maxScopeSessions + 1 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    mockManage(status({ projects: extra }));
    render(<CompanionSection />);
    expect(await screen.findByText(text.scopeCapped)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.create }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(COMPANION_MANAGE_CHANNEL, {
      action: 'invite',
      scope: extra.slice(0, COMPANION_LIMITS.maxScopeSessions).map(project => `project:${project.id}`),
    }));
  });

  it('shows an empty-library state and does not invite', async () => {
    mockManage(status({ projects: [], sessions: [] }));
    render(<CompanionSection />);
    expect(await screen.findByText(text.empty)).toBeTruthy();
    expect((screen.getByRole('button', { name: text.create }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: text.create }));
    expect(invoke.mock.calls.some(call => call[1]?.action === 'invite')).toBe(false);
  });

  it('lists device name, pairing time, scope, and the legacy re-pair hint', async () => {
    mockManage(status({
      devices: [
        { deviceId: 'phone-old', scope: ['s1'], scopeEpoch: 1, name: 'Pixel 7', pairedAt: 1_700_000_000_000 },
        { deviceId: 'phone-new', scope: ['project:one', 'project:two'], scopeEpoch: 1, name: 'Pixel 8', pairedAt: 1_700_000_100_000 },
      ],
    }));
    render(<CompanionSection />);
    expect(await screen.findByText('Pixel 7')).toBeTruthy();
    expect(screen.getByText('Pixel 8')).toBeTruthy();
    expect(screen.getByText(text.legacyScope)).toBeTruthy();
    expect(screen.getByText(text.scopeAll)).toBeTruthy();
    expect(screen.getByText(text.scopeLimited)).toBeTruthy();
    expect(screen.getAllByText(new RegExp(text.pairedAt)).length).toBe(2);
  });

  it('renders errors as i18n copy with the code in parentheses, not a raw code tag', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockImplementation(async (_channel: string, request: { action: string }) => {
      if (request.action === 'status') return status();
      throw new Error('COMPANION_LAN_UNAVAILABLE');
    });
    render(<CompanionSection />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: text.create }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`${text.errorLan} (COMPANION_LAN_UNAVAILABLE)`);
    expect(document.querySelector('code')).toBeNull();
  });
});

describe('CompanionSection remote kill switch', () => {
  afterEach(() => { cleanup(); invoke.mockReset(); toDataURL.mockClear(); authMock.reset(); i18nState.language = 'zh'; });

  /** 按 action 分发结果：setRemote 等写操作不会再误吞成 invitation。 */
  function mockStatuses(byAction: Record<string, CompanionManagementResult>) {
    invoke.mockImplementation(async (_channel: string, request: { action: string }) => {
      const result = byAction[request.action];
      if (!result) throw new Error(`UNEXPECTED_ACTION_${request.action}`);
      return result;
    });
  }

  function pairedDevices(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      deviceId: `phone-${index}`, scope: ['project:one'], scopeEpoch: 1, name: `Pixel ${index}`, pairedAt: 1_700_000_000_000,
    }));
  }

  it('renders the switch ON when an older host omits remoteEnabled', async () => {
    mockManage(status());
    render(<CompanionSection />);
    const toggle = await screen.findByRole('switch', { name: text.remoteTitle });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    // 设备数为 0 时给中性一行，不带「关闭会断开 N 台」的计数警示。
    expect(screen.getByTestId('companion-remote-count').textContent).toBe(text.remoteCountNone);
  });

  it('reflects remoteEnabled true/false straight from the host status result', async () => {
    mockStatuses({ status: status({ remoteEnabled: true, devices: pairedDevices(2) }) });
    const { unmount } = render(<CompanionSection />);
    const toggle = await screen.findByRole('switch', { name: text.remoteTitle });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('companion-remote-count').textContent).toBe(text.remoteCount(2));
    unmount();

    mockStatuses({ status: status({ remoteEnabled: false, devices: pairedDevices(2) }) });
    render(<CompanionSection />);
    expect((await screen.findByRole('switch', { name: text.remoteTitle })).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('companion-remote-off-hint').textContent).toBe(text.remoteOffHint);
    expect(screen.queryByTestId('companion-remote-count')).toBeNull();
  });

  it('count line mirrors status.devices.length verbatim', async () => {
    mockStatuses({ status: status({ remoteEnabled: true, devices: pairedDevices(3) }) });
    render(<CompanionSection />);
    await screen.findByRole('switch', { name: text.remoteTitle });
    expect(screen.getByTestId('companion-remote-count').textContent).toBe(text.remoteCount(3));
  });

  it('turning off opens a warning dialog, sends nothing until confirmed, then setRemote:false once and never revoke', async () => {
    const devices = pairedDevices(1);
    mockStatuses({
      status: status({ remoteEnabled: true, devices }),
      setRemote: status({ remoteEnabled: false, devices }),
    });
    render(<CompanionSection />);
    fireEvent.click(await screen.findByRole('switch', { name: text.remoteTitle }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(text.remoteOffTitle);
    expect(dialog.textContent).toContain('1');
    // 弹窗必须讲清三件事：断开 N 台、仍保持配对、随时可重开且无需重新扫码。
    expect(dialog.textContent).toContain('仍保持配对');
    expect(dialog.textContent).toContain('无需重新扫码');
    expect(invoke.mock.calls.filter(call => call[1]?.action !== 'status')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: text.remoteOffConfirmYes }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(COMPANION_MANAGE_CHANNEL, { action: 'setRemote', enabled: false }));
    expect(invoke.mock.calls.filter(call => call[1]?.action === 'setRemote')).toHaveLength(1);
    expect(invoke.mock.calls.some(call => call[1]?.action === 'revoke')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    // 开关状态来自 setRemote 返回的 status 结果，不本地硬翻。
    await waitFor(() => expect(screen.getByRole('switch', { name: text.remoteTitle }).getAttribute('aria-checked')).toBe('false'));
    expect(screen.getByTestId('companion-remote-off-hint').textContent).toBe(text.remoteOffHint);
  });

  it('cancel and Esc close the dialog and send nothing; the switch stays ON', async () => {
    mockStatuses({ status: status({ remoteEnabled: true, devices: pairedDevices(1) }) });
    render(<CompanionSection />);
    const toggle = await screen.findByRole('switch', { name: text.remoteTitle });
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.remoteOffConfirmNo }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke.mock.calls.filter(call => call[1]?.action !== 'status')).toHaveLength(0);
    expect(screen.getByRole('switch', { name: text.remoteTitle }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke.mock.calls.filter(call => call[1]?.action !== 'status')).toHaveLength(0);
  });

  it('turning on sends setRemote:true straight away, without any dialog', async () => {
    mockStatuses({ status: status({ remoteEnabled: false }), setRemote: status({ remoteEnabled: true }) });
    render(<CompanionSection />);
    fireEvent.click(await screen.findByRole('switch', { name: text.remoteTitle }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(COMPANION_MANAGE_CHANNEL, { action: 'setRemote', enabled: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: text.remoteTitle }).getAttribute('aria-checked')).toBe('true'));
  });

  it('remounting with a host status of remoteEnabled:false renders OFF', async () => {
    mockStatuses({ status: status({ remoteEnabled: false }) });
    const first = render(<CompanionSection />);
    expect((await first.findByRole('switch', { name: text.remoteTitle })).getAttribute('aria-checked')).toBe('false');
    first.unmount();
    render(<CompanionSection />);
    expect((await screen.findByRole('switch', { name: text.remoteTitle })).getAttribute('aria-checked')).toBe('false');
  });

  it('while off: shows the off hint and refuses to create a pairing code the host would reject', async () => {
    mockStatuses({ status: status({ remoteEnabled: false }) });
    render(<CompanionSection />);
    await screen.findByTestId('companion-remote-off-hint');
    const create = screen.getByRole('button', { name: text.create }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(invoke.mock.calls.some(call => call[1]?.action === 'invite')).toBe(false);
  });

  it('the off dialog explains the stay-paired / no-re-scan guarantee in English too', async () => {
    i18nState.language = 'en';
    const enText = companionText.en;
    mockStatuses({ status: status({ remoteEnabled: true, devices: pairedDevices(2) }) });
    render(<CompanionSection />);
    fireEvent.click(await screen.findByRole('switch', { name: enText.remoteTitle }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('2 paired phones');
    expect(dialog.textContent).toContain('Phones stay paired');
    expect(dialog.textContent).toContain('no re-scan needed');
    expect(invoke.mock.calls.filter(call => call[1]?.action !== 'status')).toHaveLength(0);
  });
});

describe('companionErrorCopy', () => {
  it('maps known codes and keeps unknown failures on the generic copy', () => {
    expect(companionErrorCopy(text, 'COMPANION_UNAVAILABLE')).toBe(`${text.errorUnavailable} (COMPANION_UNAVAILABLE)`);
    expect(companionErrorCopy(text, 'COMPANION_REMOTE_OFF')).toBe(`${text.errorRemoteOff} (COMPANION_REMOTE_OFF)`);
    expect(companionErrorCopy(text, 'boom')).toBe(`${text.error} (UNKNOWN_ERROR)`);
  });
});

describe('CompanionSection cross-network status', () => {
  afterEach(() => { cleanup(); invoke.mockReset(); setShowAuthModal.mockClear(); authMock.reset(); });

  function relayStatus(account: 'off' | 'signedOut' | 'connecting' | 'connected', legacy: 'connected' | 'disconnected' = 'disconnected') {
    mockManage(status({ relay: { legacy, account } }));
  }

  it('off: says local-Wi-Fi only, offers no sign-in and hides the legacy line', async () => {
    relayStatus('off');
    render(<CompanionSection />);
    expect(await screen.findByTestId('companion-crossnet')).toBeTruthy();
    expect(screen.getByText(text.crossnetOff)).toBeTruthy();
    expect(screen.getByText(text.crossnetOffHint)).toBeTruthy();
    expect(screen.queryByTestId('companion-crossnet-action')).toBeNull();
    expect(screen.queryByText(text.crossnetLegacyConnected)).toBeNull();
  });

  it('signedOut: shows the sign-in button and the legacy line; clicking opens the auth modal', async () => {
    relayStatus('signedOut', 'connected');
    render(<CompanionSection />);
    expect(await screen.findByText(text.crossnetSignedOut)).toBeTruthy();
    expect(screen.getByText(text.crossnetSignedOutHint)).toBeTruthy();
    expect(screen.getByText(text.crossnetLegacyConnected)).toBeTruthy();
    fireEvent.click(screen.getByTestId('companion-crossnet-action'));
    expect(setShowAuthModal).toHaveBeenCalledWith(true);
  });

  it('connecting: tells the user it retries automatically and hides the legacy line while it is down', async () => {
    relayStatus('connecting');
    render(<CompanionSection />);
    expect(await screen.findByText(text.crossnetConnecting)).toBeTruthy();
    expect(screen.getByText(text.crossnetConnectingHint)).toBeTruthy();
    // 旧通道没连着就不显示那行小字：没用过旧通道的用户不该看到「未连接」以为坏了。
    expect(screen.queryByText(text.crossnetLegacyConnected)).toBeNull();
    expect(screen.queryByTestId('companion-crossnet-action')).toBeNull();
  });

  it('connected: says cross-network is on via the Neo account and has no button', async () => {
    relayStatus('connected', 'connected');
    render(<CompanionSection />);
    expect(await screen.findByText(text.crossnetConnected)).toBeTruthy();
    expect(screen.getByText(text.crossnetConnectedHint)).toBeTruthy();
    expect(screen.getByText(text.crossnetLegacyConnected)).toBeTruthy();
    expect(screen.queryByTestId('companion-crossnet-action')).toBeNull();
  });

  it('re-pulls status when the login state changes after the user signs in', async () => {
    let pulls = 0;
    invoke.mockImplementation(async (_channel: string, request: { action: string }) => {
      if (request.action !== 'status') return invitation();
      pulls += 1;
      return status({ relay: { legacy: 'disconnected', account: pulls === 1 ? 'signedOut' : 'connecting' } });
    });
    render(<CompanionSection />);
    expect(await screen.findByText(text.crossnetSignedOut)).toBeTruthy();
    expect(pulls).toBe(1);
    authMock.setAuthenticated(true);
    expect(await screen.findByText(text.crossnetConnecting)).toBeTruthy();
    expect(pulls).toBe(2);
  });

  it('stays hidden when the host predates the relay status field', async () => {
    mockManage(status());
    render(<CompanionSection />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByTestId('companion-crossnet')).toBeNull();
  });
});
