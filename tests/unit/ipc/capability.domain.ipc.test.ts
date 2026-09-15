import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// capability.ipc.ts 派发特征测试（RQ-183 续作·CAPABILITY 刀迁表前钉住 switch 形态）：派发层 4 个 action（计数以切块断言为准）。
// 既有 adminSurfaces.ipc.test.ts 只钉「list 放行、setEnabled 非 admin 被 FORBIDDEN 且服务不被调」。这里补派发层契约：
// - 门的位置：除 list 外一律先过门（含 installDraft / removeDraft 与未知 action），门错误原样返回、服务不被调
// - 放行后四个 action 的委派：payload 原样透传，第二参 { workingDirectory, configService } 由 deps 现取
// - getAppService 抛错时 workingDirectory 兜 undefined（不影响分发）
// - 未知 action 放行后 → INVALID_ACTION + `Unknown action: <action>` 完整文案
// - 服务抛错 → INTERNAL_ERROR：Error 取 message、非 Error 取 String(error)
// 迁表后本文件零改动全绿即行为不变证明。门以 mock adminGuard 注入，测的是门位置而非 auth 判定。

const env = vi.hoisted(() => ({
  gate: null as null | IPCResponse,
  gateCalls: [] as string[],
  service: {
    listCapabilities: vi.fn(async (_opts: unknown): Promise<unknown> => [{ id: 'c1' }]),
    setEnabled: vi.fn(async (_req: unknown, _opts: unknown): Promise<unknown> => ({ ok: 'set' })),
    installDraft: vi.fn(async (_req: unknown, _opts: unknown): Promise<unknown> => ({ ok: 'install' })),
    removeDraft: vi.fn(async (_req: unknown, _opts: unknown): Promise<unknown> => ({ ok: 'remove' })),
  },
  config: { tag: 'config' },
  workingDirectory: '/tmp/cap' as string | undefined,
  appThrows: false,
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  getAdminAccessIpcError: (surface: string) => {
    env.gateCalls.push(surface);
    return env.gate;
  },
}));
vi.mock('../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => env.service,
}));

import { registerCapabilityHandlers } from '../../../src/host/ipc/capability.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

const FORBIDDEN: IPCResponse = { success: false, error: { code: 'FORBIDDEN', message: 'Capability Center: Admin permission required' } };

beforeEach(() => {
  vi.clearAllMocks();
  env.gate = null;
  env.gateCalls = [];
  env.workingDirectory = '/tmp/cap';
  env.appThrows = false;
  const handlers = new Map<string, HandlerFn>();
  registerCapabilityHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never, {
    getConfigService: () => env.config as never,
    getAppService: () => {
      if (env.appThrows) throw new Error('app not ready');
      return { getWorkingDirectory: () => env.workingDirectory } as never;
    },
  });
  const handler = handlers.get(IPC_DOMAINS.CAPABILITY)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('capability.ipc dispatch 特征：门位置', () => {
  it('list 不过门', async () => {
    env.gate = FORBIDDEN;
    expect(await call('list')).toEqual({ success: true, data: [{ id: 'c1' }] });
    expect(env.gateCalls).toEqual([]);
  });

  it('installDraft / removeDraft / setEnabled 被门拦时原样返回门错误，服务不被调', async () => {
    env.gate = FORBIDDEN;
    for (const action of ['setEnabled', 'installDraft', 'removeDraft']) {
      expect(await call(action, { id: 'x' })).toEqual(FORBIDDEN);
    }
    expect(env.gateCalls).toEqual(['Capability Center', 'Capability Center', 'Capability Center']);
    expect(env.service.setEnabled).not.toHaveBeenCalled();
    expect(env.service.installDraft).not.toHaveBeenCalled();
    expect(env.service.removeDraft).not.toHaveBeenCalled();
  });

  it('未知 action 也先过门：被拦返回门错误；放行后 INVALID_ACTION 完整文案', async () => {
    env.gate = FORBIDDEN;
    expect(await call('bogus')).toEqual(FORBIDDEN);
    env.gate = null;
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
    expect(env.gateCalls).toEqual(['Capability Center', 'Capability Center']);
  });
});

describe('capability.ipc dispatch 特征：委派', () => {
  it('四个 action 放行后 payload 原样透传，上下文由 deps 现取', async () => {
    const opts = { workingDirectory: '/tmp/cap', configService: env.config };
    expect(await call('list')).toEqual({ success: true, data: [{ id: 'c1' }] });
    expect(env.service.listCapabilities).toHaveBeenCalledWith(opts);

    expect(await call('setEnabled', { id: 's', enabled: false })).toEqual({ success: true, data: { ok: 'set' } });
    expect(env.service.setEnabled).toHaveBeenCalledWith({ id: 's', enabled: false }, opts);

    env.workingDirectory = '/tmp/other';
    const opts2 = { workingDirectory: '/tmp/other', configService: env.config };
    expect(await call('installDraft', { draft: 'd' })).toEqual({ success: true, data: { ok: 'install' } });
    expect(env.service.installDraft).toHaveBeenCalledWith({ draft: 'd' }, opts2);
    expect(await call('removeDraft', { id: 'r' })).toEqual({ success: true, data: { ok: 'remove' } });
    expect(env.service.removeDraft).toHaveBeenCalledWith({ id: 'r' }, opts2);
  });

  it('getAppService 抛错时 workingDirectory 兜 undefined，照常分发', async () => {
    env.appThrows = true;
    expect(await call('list')).toEqual({ success: true, data: [{ id: 'c1' }] });
    expect(env.service.listCapabilities).toHaveBeenCalledWith({ workingDirectory: undefined, configService: env.config });
  });
});

describe('capability.ipc dispatch 特征：兜底', () => {
  it('服务抛 Error → INTERNAL_ERROR + message；非 Error → String(error)', async () => {
    env.service.setEnabled.mockRejectedValueOnce(new Error('toggle failed'));
    expect(await call('setEnabled', {})).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'toggle failed' } });
    env.service.listCapabilities.mockRejectedValueOnce('raw list');
    expect(await call('list')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw list' } });
  });

  it('门自身抛错 → INTERNAL_ERROR（门在 try 内）', async () => {
    const orig = env.gate;
    Object.defineProperty(env, 'gate', { configurable: true, get: () => { throw new Error('auth down'); } });
    try {
      expect(await call('removeDraft', {})).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'auth down' } });
    } finally {
      Object.defineProperty(env, 'gate', { configurable: true, writable: true, value: orig });
    }
  });
});
