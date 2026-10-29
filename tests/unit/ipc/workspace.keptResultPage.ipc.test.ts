// N-BROWSER-KEEP-RESULT-PAGE：getKeptResultPage / adoptKeptResultPage 两条
// WORKSPACE 域 IPC 的接线（handler 表 + service 分发 + workspace 兜底）。
import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';
import type { IpcMain } from '../../../src/host/platform';
import type { UserBrowserLinkService } from '../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';

type UserBrowserLinks = Pick<
  UserBrowserLinkService,
  'open' | 'end' | 'history' | 'dispatchUserInput' | 'setViewport' | 'adopt' | 'keptState'
>;

function snapshot(conversationId: string): SurfaceConversationSnapshotV1 {
  return { version: 1, conversationId, sessions: [], updatedAt: 1 };
}

function createIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

function createLinks() {
  return {
    open: vi.fn(async () => ({ conversationId: 'c', runId: 'r', surfaceSessionId: 's', snapshot: snapshot('c') })),
    end: vi.fn(async () => null),
    history: vi.fn(async () => snapshot('c')),
    dispatchUserInput: vi.fn(async () => snapshot('c')),
    setViewport: vi.fn(async () => snapshot('c')),
    adopt: vi.fn(async () => ({
      conversationId: 'conversation-a',
      runId: 'user-run',
      surfaceSessionId: 'surface-user',
      snapshot: snapshot('conversation-a'),
    })),
    keptState: vi.fn(() => ({ state: 'kept', url: 'https://example.test/result', title: 'Result' })),
  } as unknown as UserBrowserLinks;
}

function install(links: UserBrowserLinks) {
  const { ipcMain, handlers } = createIpcMain();
  registerWorkspaceHandlers(ipcMain, () => null, () => null, () => null, () => links);
  const handler = handlers.get(IPC_DOMAINS.WORKSPACE);
  expect(handler).toBeDefined();
  return handler!;
}

describe('workspace kept result page wiring (N-BROWSER-KEEP-RESULT-PAGE)', () => {
  it('getKeptResultPage returns the service three-state snapshot', async () => {
    const links = createLinks();
    const handler = install(links);

    const response = await handler({}, {
      action: 'getKeptResultPage',
      payload: { conversationId: 'conversation-a' },
    } satisfies IPCRequest) as { success: boolean; data: unknown };

    expect(response.success).toBe(true);
    expect(response.data).toEqual({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(links.keptState).toHaveBeenCalledWith('conversation-a');
  });

  it('adoptKeptResultPage dispatches to the user link service with a resolved workspace', async () => {
    const links = createLinks();
    const handler = install(links);

    const response = await handler({}, {
      action: 'adoptKeptResultPage',
      payload: { conversationId: 'conversation-a' },
    } satisfies IPCRequest) as { success: boolean; data: unknown };

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      conversationId: 'conversation-a',
      surfaceSessionId: 'surface-user',
    });
    // 空 workspace 走与 openLinkInRail 同一条 host 兜底，不让认领因缺 cwd 失败。
    expect(links.adopt).toHaveBeenCalledWith({
      conversationId: 'conversation-a',
      workspace: expect.any(String),
    });
  });

  it('adoptKeptResultPage surfaces service failures as a non-success response', async () => {
    const links = createLinks();
    links.adopt = vi.fn(async () => {
      throw new Error('No kept result page is open for this conversation.');
    }) as unknown as UserBrowserLinks['adopt'];
    const handler = install(links);

    const response = await handler({}, {
      action: 'adoptKeptResultPage',
      payload: { conversationId: 'conversation-a', workspace: '/tmp/w' },
    } satisfies IPCRequest) as { success: boolean; error?: { message?: string } };

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('No kept result page');
  });
});
