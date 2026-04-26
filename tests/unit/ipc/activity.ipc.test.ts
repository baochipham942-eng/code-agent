import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCResponse } from '../../../src/shared/ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  getOpenchronicleStatus: vi.fn(),
  getNativeDesktopService: vi.fn(),
  getAudioCaptureStatus: vi.fn(),
}));

vi.mock('../../../src/main/services/external/openchronicleSupervisor', () => ({
  getStatus: mocks.getOpenchronicleStatus,
}));

vi.mock('../../../src/main/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: mocks.getNativeDesktopService,
}));

vi.mock('../../../src/main/services/desktop/desktopAudioCapture', () => ({
  getAudioCaptureStatus: mocks.getAudioCaptureStatus,
}));

import { registerActivityHandlers } from '../../../src/main/ipc/activity.ipc';

type HandlerFn = (event: unknown, request: unknown) => Promise<unknown>;

function createMockIpcMain() {
  const handlers = new Map<string, HandlerFn>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: HandlerFn) => {
        handlers.set(channel, handler);
      }),
    },
    invoke<T>(channel: string, request: unknown): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return handler({}, request) as Promise<T>;
    },
  };
}

describe('activity provider IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOpenchronicleStatus.mockResolvedValue({
      state: 'running',
      pid: 1234,
      mcpHealthy: true,
      bufferFiles: 2,
      memoryEntries: 3,
    });
    mocks.getNativeDesktopService.mockReturnValue({
      getStatus: () => ({
        running: true,
        phase: 'tauri-native-desktop',
        intervalSecs: 30,
        captureScreenshots: true,
        dedupeWindowSecs: 60,
        maxRecentEvents: 50,
        totalEventsWritten: 8,
        lastEventAtMs: 1700000000000,
        screenshotDir: '/tmp/screenshots',
        sqliteDbPath: '/tmp/desktop.sqlite3',
      }),
      getStats: () => ({
        totalEvents: 5,
        uniqueApps: 2,
        withUrls: 1,
        firstEventAtMs: 1699999990000,
        lastEventAtMs: 1700000000000,
        byApp: [],
      }),
    });
    mocks.getAudioCaptureStatus.mockReturnValue({
      capturing: false,
      captureMode: 'system-audio',
      vadReady: false,
      soxAvailable: true,
      systemAudioAvailable: true,
      asrEngine: 'whisper-cpp',
      powerMode: 'ac',
      totalSegments: 0,
      audioDir: '/tmp/audio',
      queueLength: 0,
    });
  });

  it('lists OpenChronicle and Native Desktop providers through one domain', async () => {
    const ipc = createMockIpcMain();
    registerActivityHandlers(ipc.ipcMain as any);

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.ACTIVITY, {
      action: 'listProviders',
    });

    expect(response.success).toBe(true);
    const providers = (response.data as any).providers;
    expect(providers).toHaveLength(2);
    expect(providers[0]).toMatchObject({
      id: 'openchronicle',
      kind: 'daemon',
      state: 'running',
      contextRole: 'automatic-background',
    });
    expect(providers[1]).toMatchObject({
      id: 'tauri-native-desktop',
      kind: 'bundled',
      state: 'running',
      contextRole: 'manual-scene-capture',
    });
  });

  it('rejects unknown activity actions', async () => {
    const ipc = createMockIpcMain();
    registerActivityHandlers(ipc.ipcMain as any);

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.ACTIVITY, {
      action: 'missing',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('INVALID_ACTION');
  });
});
