// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import {
  openHttpLinkInRail,
  openHttpLinkInRailAsync,
} from '../../../src/renderer/services/userBrowserLink';

describe('openHttpLinkInRail', () => {
  const invoke = vi.fn();
  const setNativeSnapshot = vi.fn(() => 'applied' as const);

  beforeEach(() => {
    invoke.mockReset();
    setNativeSnapshot.mockClear();
    (window as unknown as { domainAPI: unknown }).domainAPI = { invoke };
    (window as unknown as { __CODE_AGENT_TOKEN__: string }).__CODE_AGENT_TOKEN__ = 'hosted-web-token';
    useAppStore.setState({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      workbenchCollapsed: true,
      workbenchCollapsedByUser: false,
    });
    useSurfaceExecutionStore.setState({ setNativeSnapshot });
  });

  it('opens the browser workbench in the hosted-web harness and applies the returned Surface snapshot', async () => {
    const snapshot = { version: 1, conversationId: 'conversation-a', sessions: [], updatedAt: 1 };
    invoke.mockResolvedValue({
      success: true,
      data: {
        conversationId: 'conversation-a',
        runId: 'user-run',
        surfaceSessionId: 'surface-user',
        snapshot,
      },
    });

    expect(openHttpLinkInRail({
      href: 'https://example.test/path',
      conversationId: 'conversation-a',
      workspace: '/tmp/workspace',
    })).toBe(true);
    expect(useAppStore.getState()).toMatchObject({
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
    });
    await vi.waitFor(() => expect(setNativeSnapshot).toHaveBeenCalledWith('conversation-a', snapshot));
    expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'openLinkInRail', {
      conversationId: 'conversation-a',
      url: 'https://example.test/path',
      workspace: '/tmp/workspace',
    });
  });

  it('async path rejects when host returns failure (for N1 pending failed branch)', async () => {
    invoke.mockResolvedValue({
      success: false,
      error: { message: 'navigate failed' },
    });

    await expect(openHttpLinkInRailAsync({
      href: 'https://example.test/path',
      conversationId: 'conversation-a',
      workspace: '/tmp/workspace',
    })).rejects.toThrow(/navigate failed|Failed to open/);
  });
});
