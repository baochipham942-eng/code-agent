import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from '../../../src/host/platform';
import type { EvalRunBridge } from '../../../src/host/evaluation/evalRunBridge';
import { EVALUATION_CHANNELS } from '../../../src/shared/ipc/channels';

const guard = vi.hoisted(() => ({ denied: true }));
const caseBank = vi.hoisted(() => ({
  enumerate: vi.fn(async () => [{ id: 'case-1' }]),
  save: vi.fn(async () => ({ action: 'archive', id: 'case-1', file: '01.yaml' })),
}));
const panelProbe = vi.hoisted(() => ({
  inspect: vi.fn(() => ({
    model: 'deepseek-chat',
    provider: 'deepseek',
    priceTableVersion: 1,
    estimatedCostPerCaseUsd: 0.0021,
    splitCounts: { 'held-in': 76, 'held-out': 52, safety: 12 },
    quickCheck: { tags: ['core-path'], maxCases: 12 },
    environment: {
      available: true,
      message: '评测环境已就绪',
      packaged: false,
      platform: 'darwin',
      osJail: { enabled: false, available: true, active: false },
    },
  })),
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  getAdminAccessIpcError: () => guard.denied
    ? { success: false, error: { code: 'FORBIDDEN', message: 'admin required' } }
    : null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/evaluation/evalEnvironment', () => ({
  inspectEvalEnvironment: () => ({ repositoryRoot: '/repo' }),
}));

vi.mock('../../../src/host/testing/caseBank', () => ({
  enumerateCaseBank: caseBank.enumerate,
  saveCaseBank: caseBank.save,
}));

vi.mock('../../../src/host/evaluation/evalRunPanelProbe', () => ({
  inspectEvalRunPanel: panelProbe.inspect,
}));

import { registerEvaluationHandlers } from '../../../src/host/ipc/evaluation.ipc';

type Handler = (...args: unknown[]) => unknown;

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  const bridge = {
    startRun: vi.fn(async () => ({ runId: 'run-1' })),
    subscribe: vi.fn(() => ({ runId: 'run-1', running: true })),
    abortRun: vi.fn(async () => ({ runId: 'run-1', pid: 123, terminated: true })),
  };
  registerEvaluationHandlers(
    ipcMain as unknown as IpcMain,
    bridge as unknown as EvalRunBridge,
  );
  return { handlers, bridge };
}

describe('evaluation run IPC admin gate', () => {
  beforeEach(() => {
    guard.denied = true;
    caseBank.enumerate.mockClear();
    caseBank.save.mockClear();
    panelProbe.inspect.mockClear();
  });

  it('rejects all three mutating/stream channels before reaching the bridge', async () => {
    const { handlers, bridge } = setup();

    for (const channel of [
      EVALUATION_CHANNELS.RUN_SUITE,
      EVALUATION_CHANNELS.RUN_EVENTS,
      EVALUATION_CHANNELS.ABORT_RUN,
    ]) {
      await expect(handlers.get(channel)!(null, { runId: 'run-1', scope: 'smoke', maxCases: 1 }))
        .resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    }
    expect(bridge.startRun).not.toHaveBeenCalled();
    expect(bridge.subscribe).not.toHaveBeenCalled();
    expect(bridge.abortRun).not.toHaveBeenCalled();
  });

  it('题库读写通道同样先过 admin 门，renderer 不传仓库目录', async () => {
    const { handlers } = setup();

    await expect(handlers.get(EVALUATION_CHANNELS.LIST_CASES)!(null))
      .resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    await expect(handlers.get(EVALUATION_CHANNELS.SAVE_CASE)!(null, { action: 'archive', id: 'case-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(caseBank.enumerate).not.toHaveBeenCalled();
    expect(caseBank.save).not.toHaveBeenCalled();

    guard.denied = false;
    await expect(handlers.get(EVALUATION_CHANNELS.LIST_CASES)!(null)).resolves.toEqual([{ id: 'case-1' }]);
    await handlers.get(EVALUATION_CHANNELS.SAVE_CASE)!(null, { action: 'archive', id: 'case-1' });
    expect(caseBank.enumerate).toHaveBeenCalledWith('/repo');
    expect(caseBank.save).toHaveBeenCalledWith('/repo', { action: 'archive', id: 'case-1' });
  });

  it('lets an admin start, subscribe, and abort through the registered IPC handlers', async () => {
    guard.denied = false;
    const { handlers, bridge } = setup();

    await expect(handlers.get(EVALUATION_CHANNELS.RUN_SUITE)!(null, { scope: 'smoke', maxCases: 1 }))
      .resolves.toEqual({ runId: 'run-1' });
    await expect(handlers.get(EVALUATION_CHANNELS.RUN_EVENTS)!(null, { runId: 'run-1' }))
      .resolves.toEqual({ runId: 'run-1', running: true });
    await expect(handlers.get(EVALUATION_CHANNELS.ABORT_RUN)!(null, { runId: 'run-1' }))
      .resolves.toEqual({ runId: 'run-1', pid: 123, terminated: true });

    expect(bridge.startRun).toHaveBeenCalledTimes(1);
    expect(bridge.subscribe).toHaveBeenCalledTimes(1);
    expect(bridge.abortRun).toHaveBeenCalledTimes(1);
  });

  it('returns the read-only run-panel probe on the event channel without a run id', async () => {
    guard.denied = false;
    const { handlers, bridge } = setup();

    await expect(handlers.get(EVALUATION_CHANNELS.RUN_EVENTS)!(null))
      .resolves.toMatchObject({ model: 'deepseek-chat', priceTableVersion: 1 });

    expect(panelProbe.inspect).toHaveBeenCalledTimes(1);
    expect(bridge.subscribe).not.toHaveBeenCalled();
  });
});
