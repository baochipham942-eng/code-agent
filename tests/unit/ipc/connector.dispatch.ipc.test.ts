import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// connector.ipc.ts 的 dispatch handler 覆盖（纯 helper 已在 connector.ipc.test.ts 测过）。
// 单 dispatch handler 派发 9 个 action：listStatuses/listNativeInventory/setNativeEnabled/
// retry/probe/disconnect/remove/repairPermission/openApp。mock registry/configService/
// exec/broadcast，验证委派 + 持久化副作用 + 各错误分支被 catch 成 INTERNAL_ERROR。

const env = vi.hoisted(() => ({
  registry: {
    list: vi.fn((): unknown[] => []),
    get: vi.fn((_id: string): unknown => undefined),
    configure: vi.fn(),
    unregister: vi.fn(),
    listAvailableNativeIds: vi.fn((): string[] => ['calendar', 'mail', 'reminders', 'photos']),
  },
  config: {
    getSettings: vi.fn(() => ({ connectors: { enabledNative: [] as string[] } })),
    updateSettings: vi.fn(async () => {}),
  },
  configNull: false,
  broadcast: vi.fn(),
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}));

vi.mock('../../../src/main/connectors', () => ({ getConnectorRegistry: () => env.registry }));
vi.mock('../../../src/main/platform', () => ({ broadcastToRenderer: (...a: unknown[]) => env.broadcast(...a) }));
vi.mock('child_process', () => ({ exec: (cmd: string, cb: (err: Error | null) => void) => env.exec(cmd, cb) }));
vi.mock('../../../src/main/services/infra/gracefulShutdown', () => ({ onShutdown: vi.fn() }));

import { registerConnectorHandlers } from '../../../src/main/ipc/connector.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function register() {
  const handlers = new Map<string, HandlerFn>();
  registerConnectorHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => null, // getMainWindow → null，broadcast 走 broadcastToRenderer mock
    () => (env.configNull ? null : (env.config as never)),
  );
  const handler = handlers.get(IPC_DOMAINS.CONNECTOR)!;
  return (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
}

let call: ReturnType<typeof register>;

beforeEach(() => {
  vi.useFakeTimers(); // 拦截 ensureConnectorStatusWatcher 的 setInterval
  vi.clearAllMocks();
  env.registry.list.mockReturnValue([]);
  env.registry.get.mockReturnValue(undefined);
  env.registry.listAvailableNativeIds.mockReturnValue(['calendar', 'mail', 'reminders', 'photos']);
  env.config.getSettings.mockReturnValue({ connectors: { enabledNative: [] } });
  env.config.updateSettings.mockResolvedValue(undefined);
  env.configNull = false;
  env.exec.mockImplementation((_cmd: string, cb: (err: Error | null) => void) => cb(null));
  call = register();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listStatuses / listNativeInventory', () => {
  it('listStatuses 映射 registry 连接器状态', async () => {
    env.registry.list.mockReturnValue([
      {
        id: 'mail',
        label: 'Mail',
        getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: ['read'], actions: ['sync'] }),
      },
    ]);
    const res = await call('listStatuses');
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject([{ id: 'mail', connected: true, readiness: 'ready' }]);
  });

  it('listNativeInventory 标注 enabled 状态', async () => {
    env.config.getSettings.mockReturnValue({ connectors: { enabledNative: ['mail'] } });
    const items = (await call('listNativeInventory')).data as Array<{ id: string; enabled: boolean }>;
    expect(items.find((i) => i.id === 'mail')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'calendar')?.enabled).toBe(false);
  });

  it('configService 为 null 时 enabledNative 视为空', async () => {
    env.configNull = true;
    call = register();
    const items = (await call('listNativeInventory')).data as Array<{ enabled: boolean }>;
    expect(items.every((i) => !i.enabled)).toBe(true);
  });
});

describe('setNativeEnabled', () => {
  it('启用合法原生 id → 持久化 + configure', async () => {
    const res = await call('setNativeEnabled', { id: 'mail', enabled: true });
    expect(res.success).toBe(true);
    expect(env.config.updateSettings).toHaveBeenCalledWith({ connectors: { enabledNative: ['mail'] } });
    expect(env.registry.configure).toHaveBeenCalledWith(['mail']);
  });

  it('禁用时从集合移除', async () => {
    env.config.getSettings.mockReturnValue({ connectors: { enabledNative: ['mail', 'calendar'] } });
    await call('setNativeEnabled', { id: 'mail', enabled: false });
    expect(env.config.updateSettings).toHaveBeenCalledWith({ connectors: { enabledNative: ['calendar'] } });
  });

  it('未知 id → INTERNAL_ERROR', async () => {
    expect(await call('setNativeEnabled', { id: 'slack', enabled: true })).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});

describe('retry', () => {
  it('未注册的原生连接器 → 追加启用并持久化', async () => {
    env.registry.get.mockReturnValue(undefined);
    const res = await call('retry', { connectorId: 'mail' });
    expect(res.success).toBe(true);
    expect(env.config.updateSettings).toHaveBeenCalledWith({ connectors: { enabledNative: ['mail'] } });
  });

  it('未知的非原生连接器且无注册 → 报错', async () => {
    expect(await call('retry', { connectorId: 'ghost' })).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('Unknown connector') },
    });
  });

  it('无 connectorId → 直接回执当前状态', async () => {
    expect((await call('retry', {})).success).toBe(true);
  });
});

describe('probe', () => {
  it('缺 connectorId → 报错', async () => {
    expect(await call('probe', {})).toMatchObject({ success: false, error: { message: expect.stringContaining('required') } });
  });

  it('未知连接器 → 报错', async () => {
    expect(await call('probe', { connectorId: 'mail' })).toMatchObject({ success: false, error: { message: expect.stringContaining('Unknown connector') } });
  });

  it('存在连接器 → execute probe_access', async () => {
    const execute = vi.fn(async () => {});
    env.registry.get.mockReturnValue({ execute });
    const res = await call('probe', { connectorId: 'mail' });
    expect(res.success).toBe(true);
    expect(execute).toHaveBeenCalledWith('probe_access', {});
  });
});

describe('disconnect / remove', () => {
  it('disconnect 原生连接器 → execute + unregister + 持久化', async () => {
    env.config.getSettings.mockReturnValue({ connectors: { enabledNative: ['mail'] } });
    const execute = vi.fn(async () => {});
    env.registry.get.mockReturnValue({ execute });
    const res = await call('disconnect', { connectorId: 'mail' });
    expect(res.success).toBe(true);
    expect(execute).toHaveBeenCalledWith('disconnect', {});
    expect(env.registry.unregister).toHaveBeenCalledWith('mail');
    expect(env.config.updateSettings).toHaveBeenCalledWith({ connectors: { enabledNative: [] } });
  });

  it('disconnect 非原生 id → 报错', async () => {
    expect(await call('disconnect', { connectorId: 'slack' })).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('remove 原生连接器 → execute remove + unregister', async () => {
    env.config.getSettings.mockReturnValue({ connectors: { enabledNative: ['calendar'] } });
    const execute = vi.fn(async () => {});
    env.registry.get.mockReturnValue({ execute });
    const res = await call('remove', { connectorId: 'calendar' });
    expect(res.success).toBe(true);
    expect(execute).toHaveBeenCalledWith('remove', {});
    expect(env.registry.unregister).toHaveBeenCalledWith('calendar');
  });
});

describe('repairPermission', () => {
  it('原生 + 已注册 → execute repair_permissions', async () => {
    const execute = vi.fn(async () => {});
    env.registry.get.mockReturnValue({ execute });
    const res = await call('repairPermission', { connectorId: 'mail' });
    expect(res.success).toBe(true);
    expect(execute).toHaveBeenCalledWith('repair_permissions', {});
  });

  it('原生但未注册 → 报错', async () => {
    env.registry.get.mockReturnValue(undefined);
    expect(await call('repairPermission', { connectorId: 'mail' })).toMatchObject({ success: false, error: { message: expect.stringContaining('Unknown connector') } });
  });

  it('非原生 id → 报错', async () => {
    expect(await call('repairPermission', { connectorId: 'x' })).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
});

describe('openApp', () => {
  it('合法 mail → exec open -a Mail', async () => {
    const res = await call('openApp', { connectorId: 'mail' });
    expect(res).toMatchObject({ success: true, data: { opened: true, app: 'Mail' } });
    expect(env.exec).toHaveBeenCalledWith(expect.stringContaining('open -a "Mail"'), expect.any(Function));
  });

  it('缺 connectorId → 报错', async () => {
    expect(await call('openApp', {})).toMatchObject({ success: false, error: { message: expect.stringContaining('required') } });
  });

  it('无原生 app 映射 → 报错', async () => {
    expect(await call('openApp', { connectorId: 'photos' })).toMatchObject({ success: false, error: { message: expect.stringContaining('no native app') } });
  });

  it('exec 失败 → INTERNAL_ERROR', async () => {
    env.exec.mockImplementation((_cmd: string, cb: (err: Error | null) => void) => cb(new Error('open boom')));
    expect(await call('openApp', { connectorId: 'mail' })).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'open boom' } });
  });
});

describe('未知 action', () => {
  it('返回 INVALID_ACTION', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });
});
