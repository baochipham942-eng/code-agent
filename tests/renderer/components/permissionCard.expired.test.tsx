// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionDecision, PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null }));
const sendPrompt = vi.hoisted(() => vi.fn(async () => {}));

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
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (value: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

function resolvedRequest(decision: PermissionDecision): PermissionRequest {
  return {
    id: `permission-${decision}`,
    sessionId: 'session-current',
    tool: 'Bash',
    type: 'command',
    details: { command: 'git status --short' },
    timestamp: 1,
    resolved: true,
    decision,
  };
}

afterEach(() => {
  cleanup();
  state.request = null;
  sendPrompt.mockClear();
});

describe('PermissionCard resolved states', () => {
  it('renders timeout as expired, disables all four options, and sends the fixed retry prompt once', () => {
    state.request = resolvedRequest('timeout');
    render(<PermissionCard />);

    expect(screen.getByTestId('permission-card').className).toContain('chat-col-pad');
    expect(screen.getByTestId('permission-card').firstElementChild?.className).toContain('shadow-md');
    expect(screen.getByTestId('permission-card').firstElementChild?.className).toContain('dark:shadow-2xl');
    expect(screen.getByTestId('permission-result-expired').textContent).toContain('已过期');
    for (const name of ['允许一次', '本会话允许', '始终允许', '拒绝']) {
      expect((screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.queryByText('y')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '告诉模型继续' }));
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('刚才的审批超时了，请重试');
  });

  it('renders badges for allow-once, always-allow, and denied decisions', () => {
    state.request = resolvedRequest('once');
    const { rerender } = render(<PermissionCard />);
    expect(screen.getByTestId('permission-card').className).toContain('chat-col-pad');
    expect(screen.getByTestId('permission-result-once').textContent).toContain('允许一次');

    state.request = resolvedRequest('always');
    rerender(<PermissionCard />);
    expect(screen.getByTestId('permission-result-always').textContent).toContain('始终允许');

    state.request = resolvedRequest('deny');
    rerender(<PermissionCard />);
    expect(screen.getByTestId('permission-result-denied').textContent).toContain('已拒绝');
  });
});
