import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInboxItem } from '../../../src/shared/contract/channel';
import { CHANNEL_CHANNELS } from '../../../src/shared/ipc/channels';

const channelState = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const manager = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return manager;
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    getAccounts: vi.fn(),
    getRegisteredChannelTypes: vi.fn(),
    getChannelMeta: vi.fn(),
    getInboxItems: vi.fn(),
    dismissInboxItem: vi.fn(),
    addAccount: vi.fn(),
    updateAccount: vi.fn(),
    deleteAccount: vi.fn(),
    connectAccount: vi.fn(),
    disconnectAccount: vi.fn(),
  };

  return {
    listeners,
    manager,
  };
});

vi.mock('../../../src/main/channels', () => ({
  getChannelManager: () => channelState.manager,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerChannelHandlers } from '../../../src/main/ipc/channel.ipc';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

function createMockIpcMain() {
  const handlers = new Map<string, HandlerFn>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: HandlerFn) => {
        handlers.set(channel, handler);
      }),
      on: vi.fn(),
      once: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return Promise.resolve(handler({}, ...args) as T);
    },
  };
}

function createMainWindow() {
  return {
    webContents: {
      send: vi.fn(),
    },
  };
}

const inboxItem: ChannelInboxItem = {
  id: 'account-1:message-1',
  accountId: 'account-1',
  accountName: 'Feishu Bot',
  channelType: 'feishu',
  message: {
    id: 'message-1',
    channelId: 'account-1',
    sender: { id: 'user-1', name: 'Dad' },
    context: { chatId: 'chat-1', chatType: 'p2p' },
    content: '帮我看一下这份设计稿',
    timestamp: 1710000000000,
  },
  receivedAt: 1710000000000,
  status: 'new',
};

describe('channel.ipc inbox handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelState.listeners.clear();
    channelState.manager.getAccounts.mockReturnValue([]);
    channelState.manager.getRegisteredChannelTypes.mockReturnValue([]);
    channelState.manager.getInboxItems.mockReturnValue([inboxItem]);
    channelState.manager.dismissInboxItem.mockReturnValue(true);
  });

  it('registers list and dismiss handlers for channel inbox', async () => {
    const ipc = createMockIpcMain();
    registerChannelHandlers(ipc.ipcMain as never, () => null);

    await expect(ipc.invoke(CHANNEL_CHANNELS.LIST_INBOX)).resolves.toEqual([inboxItem]);
    await expect(ipc.invoke(CHANNEL_CHANNELS.DISMISS_INBOX_ITEM, inboxItem.id)).resolves.toBe(true);
    expect(channelState.manager.dismissInboxItem).toHaveBeenCalledWith(inboxItem.id);
  });

  it('forwards inbox_changed events to the renderer', () => {
    const ipc = createMockIpcMain();
    const mainWindow = createMainWindow();
    registerChannelHandlers(ipc.ipcMain as never, () => mainWindow as never);

    channelState.manager.emit('inbox_changed', [inboxItem]);

    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      CHANNEL_CHANNELS.INBOX_CHANGED,
      [inboxItem],
    );
  });
});
