// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_LIMITS, COMPANION_MANAGE_CHANNEL } from '../../../src/shared/constants/companion';
import { companionErrorCopy, companionText } from '../../../src/renderer/i18n/companion';
import type { CompanionManagementResult } from '../../../src/shared/contract/companionManagement';

const invoke = vi.hoisted(() => vi.fn());
const toDataURL = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,qr'));

vi.mock('../../../src/renderer/services/ipcService', () => ({ invoke }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ language: 'zh' }) }));
vi.mock('qrcode', () => ({ default: { toDataURL } }));

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
  afterEach(() => { cleanup(); invoke.mockReset(); toDataURL.mockClear(); });
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
        { deviceId: 'phone-old', scope: ['s1'], name: 'Pixel 7', pairedAt: 1_700_000_000_000 },
        { deviceId: 'phone-new', scope: ['project:one', 'project:two'], name: 'Pixel 8', pairedAt: 1_700_000_100_000 },
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

describe('companionErrorCopy', () => {
  it('maps known codes and keeps unknown failures on the generic copy', () => {
    expect(companionErrorCopy(text, 'COMPANION_UNAVAILABLE')).toBe(`${text.errorUnavailable} (COMPANION_UNAVAILABLE)`);
    expect(companionErrorCopy(text, 'boom')).toBe(`${text.error} (UNKNOWN_ERROR)`);
  });
});
