import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// openchronicle.ipc.ts 派发特征测试（RQ-183 续作·OPENCHRONICLE 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 4 个 action（计数以切块断言为准）。
// - getSettings / getStatus 委派 supervisor 并原样回传
// - updateSettings 以 payload 原样调 saveSettings，回 { success: true }（返回值不透传）
// - setEnabled 解出 payload.enabled 透传，回传 setEnabled 结果
// - 未知 action → INVALID_ACTION + `Unknown action: <action>` 完整文案
// - 抛错 → INTERNAL_ERROR：Error 取 message、非 Error 取 String(error)
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  loadSettings: vi.fn(async (): Promise<unknown> => ({ enabled: true, intervalSecs: 30 })),
  saveSettings: vi.fn(async (_s: unknown): Promise<unknown> => 'ignored-return'),
  setEnabled: vi.fn(async (_e: boolean): Promise<unknown> => ({ state: 'running' })),
  getStatus: vi.fn(async (): Promise<unknown> => ({ state: 'stopped', pid: null })),
}));

vi.mock('../../../src/host/services/external/openchronicleSupervisor', () => ({
  loadSettings: () => h.loadSettings(),
  saveSettings: (s: unknown) => h.saveSettings(s),
  setEnabled: (e: boolean) => h.setEnabled(e),
  getStatus: () => h.getStatus(),
}));

import { registerOpenchronicleHandlers } from '../../../src/host/ipc/openchronicle.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, HandlerFn>();
  registerOpenchronicleHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.OPENCHRONICLE)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('openchronicle.ipc dispatch 特征', () => {
  it('getSettings / getStatus 委派并原样回传', async () => {
    expect(await call('getSettings')).toEqual({ success: true, data: { enabled: true, intervalSecs: 30 } });
    expect(await call('getStatus')).toEqual({ success: true, data: { state: 'stopped', pid: null } });
  });

  it('updateSettings 以 payload 原样保存，回 { success: true } 不透传返回值', async () => {
    const next = { enabled: false, intervalSecs: 60 };
    expect(await call('updateSettings', next)).toEqual({ success: true, data: { success: true } });
    expect(h.saveSettings).toHaveBeenCalledWith(next);
  });

  it('setEnabled 解出 enabled 透传并回传结果', async () => {
    expect(await call('setEnabled', { enabled: false, extra: 1 })).toEqual({ success: true, data: { state: 'running' } });
    expect(h.setEnabled).toHaveBeenCalledWith(false);
  });

  it('未知 action → INVALID_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛 Error → INTERNAL_ERROR + message；抛非 Error → String(error)', async () => {
    h.getStatus.mockRejectedValueOnce(new Error('daemon down'));
    expect(await call('getStatus')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'daemon down' } });
    h.saveSettings.mockRejectedValueOnce('raw save');
    expect(await call('updateSettings', {})).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw save' } });
  });
});
