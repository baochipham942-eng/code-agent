import { describe, expect, it, vi } from 'vitest';

import { registerCheckpointHandlers } from '../../../src/host/ipc/checkpoint.ipc';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { getFileCheckpointService } from '../../../src/host/services/checkpoint';

vi.mock('../../../src/host/services/checkpoint', () => ({
  getFileCheckpointService: vi.fn(),
}));

describe('legacy checkpoint Fork tombstone', () => {
  it('fails closed without touching files or messages', async () => {
    const rewindFiles = vi.fn();
    vi.mocked(getFileCheckpointService).mockReturnValue({ rewindFiles } as never);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
    };
    registerCheckpointHandlers(ipcMain as never);

    const handler = handlers.get(IPC_CHANNELS.CHECKPOINT_FORK);
    expect(handler).toBeDefined();
    await expect(handler?.({}, 'source', 'a2')).resolves.toEqual({
      success: false,
      code: 'LEGACY_FORK_RETIRED',
      filesRestored: 0,
      messagesTruncated: 0,
      error: 'checkpoint:fork was retired; use domain:session/fork',
    });
    expect(rewindFiles).not.toHaveBeenCalled();
  });
});
