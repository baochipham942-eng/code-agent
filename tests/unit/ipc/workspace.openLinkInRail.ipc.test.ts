import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';
import type { IpcMain } from '../../../src/host/platform';

describe('workspace openLinkInRail wiring', () => {
  it('dispatches the renderer request to the user-owned browser service', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    const open = vi.fn(async () => ({
      conversationId: 'conversation-a',
      runId: 'user-run',
      surfaceSessionId: 'surface-user',
      snapshot: { version: 1 as const, conversationId: 'conversation-a', sessions: [], updatedAt: 1 },
    }));

    const end = vi.fn(async () => null);
    const history = vi.fn(async () => ({
      version: 1 as const,
      conversationId: 'conversation-a',
      sessions: [],
      updatedAt: 1,
    }));
    registerWorkspaceHandlers(
      ipcMain,
      () => null,
      () => null,
      () => null,
      () => ({ open, end, history }),
    );
    const handler = handlers.get(IPC_DOMAINS.WORKSPACE);
    expect(handler).toBeDefined();
    const request: IPCRequest = {
      action: 'openLinkInRail',
      payload: {
        conversationId: 'conversation-a',
        url: 'https://example.test/path',
        workspace: '/tmp/workspace',
      },
    };

    const response = await handler?.({}, request) as { success: boolean; data: unknown };
    expect(response.success).toBe(true);
    expect(open).toHaveBeenCalledWith(request.payload);

    const closeResponse = await handler?.({}, {
      action: 'closeLinkInRail',
      payload: { conversationId: 'conversation-a', reason: 'session-switch' },
    } satisfies IPCRequest) as { success: boolean };
    expect(closeResponse.success).toBe(true);
    expect(end).toHaveBeenCalledWith('conversation-a', 'session-switch');
  });
});
