// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
}));
const invoke = vi.hoisted(() => vi.fn());
const saveMemory = vi.hoisted(() => vi.fn());
const checkMemory = vi.hoisted(() => vi.fn(() => null));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    language: 'zh',
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory, saveMemory }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

function computerRequest(forceConfirm?: boolean): PermissionRequest {
  return {
    id: forceConfirm ? 'permission-forced' : 'permission-app',
    sessionId: 'session-current',
    tool: 'computer_use',
    type: 'command',
    forceConfirm,
    details: { targetApp: { name: 'Notes' } },
    timestamp: 1,
  };
}

describe('PermissionCard computer app grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.request = computerRequest();
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse('permission-app');
    releaseApprovalResponse('permission-forced');
  });

  it('names the app and offers always, this conversation, and deny', () => {
    render(<PermissionCard />);
    expect(screen.getByText('允许 Neo 操作 Notes？')).toBeTruthy();
    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    const choices = labels.filter((label) => /始终允许|本次对话允许|拒绝/.test(label));
    expect(choices.map((label) => label.replace(/\s+/g, ''))).toEqual([
      '始终允许a',
      '本次对话允许s',
      '拒绝n',
    ]);
    expect(screen.queryByRole('button', { name: /允许一次/ })).toBeNull();
    expect(checkMemory).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('asks about operating the app, not the underlying command wording', () => {
    state.request = {
      ...computerRequest(),
      id: 'permission-app-safari',
      details: { targetApp: { name: 'Safari' } },
    };
    const { container } = render(<PermissionCard />);
    expect(screen.getByText('Neo 想操作 Safari，你来决定。')).toBeTruthy();
    expect(container.textContent).not.toContain('执行这条命令');
  });

  it('keeps the dangerous command wording when the app request itself is dangerous', () => {
    state.request = {
      ...computerRequest(),
      id: 'permission-app-dangerous',
      type: 'dangerous_command',
      details: { targetApp: { name: 'Safari' }, command: 'rm -rf /tmp/x' },
    };
    const { container } = render(<PermissionCard />);
    expect(container.textContent).toContain('允许执行这条命令');
  });

  it('keeps the command wording for forceConfirm requests', () => {
    state.request = computerRequest(true);
    const { container } = render(<PermissionCard />);
    expect(container.textContent).toContain('允许执行这条命令');
  });

  it('maps the three buttons to standing, session, and deny without touching permission memory', () => {
    const { rerender } = render(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /始终允许/ }));
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'permission-app',
      'allow_standing',
      'session-current',
    );
    expect(saveMemory).not.toHaveBeenCalled();

    invoke.mockClear();
    releaseApprovalResponse('permission-app');
    state.request = { ...computerRequest(), id: 'permission-app-2' };
    rerender(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /本次对话允许/ }));
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'permission-app-2',
      'allow_session',
      'session-current',
    );

    invoke.mockClear();
    releaseApprovalResponse('permission-app-2');
    state.request = { ...computerRequest(), id: 'permission-app-3' };
    rerender(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'permission-app-3',
      'deny',
      'session-current',
    );
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('keeps a forceConfirm card on once and deny', () => {
    state.request = computerRequest(true);
    render(<PermissionCard />);
    expect(screen.queryByText('允许 Neo 操作 Notes？')).toBeNull();
    expect(screen.getByRole('button', { name: /允许一次/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /本次对话允许/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /始终允许/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'permission-forced',
      'allow',
      'session-current',
    );
    expect(saveMemory).not.toHaveBeenCalled();
  });
});
