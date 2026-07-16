// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  sessionId: 'session-current' as string | null,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

const request: PermissionRequest = {
  id: 'permission-hooks-1',
  sessionId: 'session-current',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/hook-order.txt' },
  timestamp: 1,
};

describe('PermissionCard hook ordering', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    state.request = null;
  });

  it('renders when a permission request becomes available after an empty render', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(<PermissionCard />);

    state.request = request;
    expect(() => rerender(<PermissionCard />)).not.toThrow();

    expect(screen.getByText('/tmp/hook-order.txt')).toBeTruthy();
    expect(
      consoleError.mock.calls.some((args) =>
        args.some(
          (arg) => typeof arg === 'string' && /change in the order of Hooks|Rendered more hooks/.test(arg),
        ),
      ),
    ).toBe(false);
  });
});
