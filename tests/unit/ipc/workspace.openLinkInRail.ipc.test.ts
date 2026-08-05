import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';
import type { IpcMain } from '../../../src/host/platform';
import type { UserBrowserLinkService } from '../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';

type UserBrowserLinks = Pick<
  UserBrowserLinkService,
  'open' | 'end' | 'history' | 'dispatchUserInput' | 'setViewport'
>;

function snapshot(conversationId: string): SurfaceConversationSnapshotV1 {
  return {
    version: 1,
    conversationId,
    sessions: [],
    updatedAt: 1,
  };
}

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
      snapshot: snapshot('conversation-a'),
    }));
    const end = vi.fn(async () => null);
    const history = vi.fn(async () => snapshot('conversation-a'));
    const dispatchUserInput = vi.fn(async () => snapshot('conversation-a'));
    const setViewport = vi.fn(async () => snapshot('conversation-a'));
    const links: UserBrowserLinks = {
      open,
      end,
      history,
      dispatchUserInput,
      setViewport,
    };

    registerWorkspaceHandlers(
      ipcMain,
      () => null,
      () => null,
      () => null,
      () => links,
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

  // R2：dispatch/history 必须与 open 同口径兜底空 workspace；缺兜底时快速对话零透传。
  it('dispatchUserBrowserInput 在空 workspace 时仍调用 service（host 兜底）', async () => {
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
      snapshot: snapshot('conversation-a'),
    }));
    const end = vi.fn(async () => null);
    const history = vi.fn(async () => snapshot('conversation-a'));
    const dispatchUserInput = vi.fn(async () => snapshot('conversation-a'));
    const setViewport = vi.fn(async () => snapshot('conversation-a'));
    const links: UserBrowserLinks = {
      open,
      end,
      history,
      dispatchUserInput,
      setViewport,
    };

    registerWorkspaceHandlers(
      ipcMain,
      () => null,
      () => null,
      () => null,
      () => links,
    );
    const handler = handlers.get(IPC_DOMAINS.WORKSPACE);
    const response = await handler?.({}, {
      action: 'dispatchUserBrowserInput',
      payload: {
        conversationId: 'conversation-a',
        workspace: '',
        input: { kind: 'click', x: 10, y: 20, button: 'left', clickCount: 1 },
      },
    } satisfies IPCRequest) as { success: boolean; error?: { message?: string } };
    expect(response.success).toBe(true);
    expect(dispatchUserInput).toHaveBeenCalledOnce();
    const dispatchCalls = dispatchUserInput.mock.calls as unknown as Array<[
      { conversationId: string; workspace: string; input: unknown },
    ]>;
    expect(dispatchCalls.length).toBeGreaterThan(0);
    const arg = dispatchCalls[0]![0];
    expect(arg.conversationId).toBe('conversation-a');
    // host 必须填入非空 workspace（会话目录或 dataDir/work 兜底），不能把空串原样传给 service
    expect(arg.workspace.trim().length).toBeGreaterThan(0);
    expect(arg.workspace.endsWith('work') || arg.workspace.includes('work')).toBe(true);

    const historyResponse = await handler?.({}, {
      action: 'controlUserBrowserHistory',
      payload: {
        conversationId: 'conversation-a',
        workspace: '',
        action: 'back',
      },
    } satisfies IPCRequest) as { success: boolean };
    expect(historyResponse.success).toBe(true);
    expect(history).toHaveBeenCalledOnce();
    const historyCalls = history.mock.calls as unknown as Array<[
      { workspace: string; action: string },
    ]>;
    expect(historyCalls.length).toBeGreaterThan(0);
    const historyArg = historyCalls[0]![0];
    expect(historyArg.workspace.trim().length).toBeGreaterThan(0);
    expect(historyArg.action).toBe('back');
  });
});
