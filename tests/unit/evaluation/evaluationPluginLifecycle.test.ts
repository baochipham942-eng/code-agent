import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from '../../../src/host/platform';
import { isAdminChannel } from '../../../src/host/ipc/channelAccessPolicy';
import { activate } from '../../../packages/internal/evaluation-center/src/host/entry';
import { getEvalRunBridge } from '../../../packages/internal/evaluation-center/src/host/evaluation/evalRunBridge';
import { EVALUATION_CHANNELS } from '../../../packages/internal/evaluation-center/src/shared/evaluationChannels';

type Handler = (...args: unknown[]) => unknown;

function testIpc() {
  const handlers = new Map<string, Handler>();
  const removeHandler = vi.fn((channel: string) => { handlers.delete(channel); });
  const ipcMain = {
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
    removeHandler,
  } as unknown as IpcMain;
  return { handlers, ipcMain, removeHandler };
}

afterEach(() => {
  const runs = Reflect.get(getEvalRunBridge(), 'runs') as Map<string, unknown>;
  runs.clear();
  vi.restoreAllMocks();
});

describe('evaluation-center plugin lifecycle', () => {
  it('registers every evaluation handler and idempotently removes handlers and admin channels', async () => {
    const { handlers, ipcMain, removeHandler } = testIpc();
    const lifecycle = await activate({ ipcMain, sdk: { version: 'test', modules: {} } });
    expect([...handlers.keys()].sort()).toEqual(Object.values(EVALUATION_CHANNELS).sort());
    expect(isAdminChannel(EVALUATION_CHANNELS.RUN_SUITE)).toBe(true);

    await lifecycle.deactivate();
    await lifecycle.deactivate();

    expect(handlers.size).toBe(0);
    expect(removeHandler).toHaveBeenCalledTimes(Object.values(EVALUATION_CHANNELS).length);
    expect(isAdminChannel(EVALUATION_CHANNELS.RUN_SUITE)).toBe(false);
  });

  it('aborts every active run with the plugin update reason during deactivate', async () => {
    const bridge = getEvalRunBridge();
    const runs = Reflect.get(bridge, 'runs') as Map<string, unknown>;
    runs.set('run-active', {});
    const abortRun = vi.spyOn(bridge, 'abortRun').mockResolvedValue({
      runId: 'run-active',
      pid: 123,
      terminated: true,
    });
    const { ipcMain } = testIpc();
    const lifecycle = await activate({ ipcMain, sdk: { version: 'test', modules: {} } });

    await lifecycle.deactivate();

    expect(abortRun).toHaveBeenCalledWith('run-active', '插件正在更新');
  });
});

