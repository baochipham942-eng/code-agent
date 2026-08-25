// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null }));

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
  useMessageActionStore: (selector: (value: { sendPrompt: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ sendPrompt: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

function request(details: PermissionRequest['details']): PermissionRequest {
  return {
    id: 'permission-redact',
    sessionId: 'session-current',
    tool: 'Bash',
    type: 'command',
    details,
    timestamp: 1,
  };
}

afterEach(() => {
  cleanup();
  state.request = null;
});

describe('PermissionCard credential redaction', () => {
  it('masks every detail value and title until the user reveals only the original command', () => {
    const command = 'curl -H "Authorization: Bearer sk-abc12345" https://api.example.com?token=ghp_abcdefghijklmnopqrstuvwxyz';
    const filePath = '/tmp/sk-path12345/config.json';
    const url = 'https://user:password@example.com?token=ghp_abcdefghijklmnopqrstuvwxyz';
    state.request = request({ command, path: filePath, url });

    const { container } = render(<PermissionCard />);

    expect(container.textContent).not.toContain('sk-abc12345');
    expect(container.textContent).not.toContain('sk-path12345');
    expect(container.textContent).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(container.textContent).not.toContain('user:password');
    for (const element of container.querySelectorAll('[title]')) {
      const title = element.getAttribute('title') || '';
      expect(title).not.toContain('sk-abc12345');
      expect(title).not.toContain('sk-path12345');
      expect(title).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(title).not.toContain('user:password');
    }

    expect(screen.getByText('已脱敏')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看原始命令' }));

    expect(container.textContent).toContain(command);
    expect(container.textContent).toContain('共享屏幕时别点');
    expect(screen.getByRole('button', { name: '隐藏原始命令' })).toBeTruthy();
    for (const element of container.querySelectorAll('[title]')) {
      expect(element.getAttribute('title')).not.toContain('sk-abc12345');
    }
  });

  it('does not add redaction controls to commands without credentials', () => {
    state.request = request({ command: 'git status --short' });
    render(<PermissionCard />);

    expect(screen.queryByText('已脱敏')).toBeNull();
    expect(screen.queryByRole('button', { name: '查看原始命令' })).toBeNull();
  });
});
