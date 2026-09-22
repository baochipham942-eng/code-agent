import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// pii.ipc.ts 派发特征测试（RQ-183 续作·PII 刀迁表前钉住 switch 形态）：派发层 4 个 action（计数以切块断言为准）。
// 既有 pii.ipc.test.ts 覆盖 setup:isReady / setup:status / setup:start 业务全路径与未知 action 完整文案。这里补派发层契约：
// - setup:cancel：未在跑 → { cancelled: false }；在跑 → 对子进程发 SIGTERM 并回 { cancelled: true }
// - 抛错兜底：startSetup 内 spawn 同步抛 Error → INTERNAL_ERROR + message，并以 { action, error: message } 记 error 日志；
//   抛非 Error → INTERNAL_ERROR + String(error)，日志 error 同为 String(error)
// 迁表后本文件零改动全绿即行为不变证明。模块有进程级 runtime 状态，每条用例 resetModules 重新加载。

const env = vi.hoisted(() => ({
  spawn: vi.fn(),
  logError: vi.fn(),
  lastChild: null as null | (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }),
}));

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isFile: () => true }),
  readFileSync: () => '',
}));
vi.mock('os', () => ({ homedir: () => '/home/test' }));
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => env.spawn(...args) }));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: env.logError, debug: vi.fn() }),
}));

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

async function load(): Promise<(action: string) => Promise<IPCResponse>> {
  vi.resetModules();
  const { registerPiiHandlers } = await import('../../../src/host/ipc/pii.ipc');
  const handlers = new Map<string, HandlerFn>();
  registerPiiHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.PII)!;
  return (action) => handler(null, { action } as IPCRequest);
}

beforeEach(() => {
  env.logError.mockReset();
  env.lastChild = null;
  env.spawn = vi.fn(() => {
    const child = makeChild();
    env.lastChild = child;
    return child;
  });
});

describe('pii.ipc dispatch 特征：setup:cancel', () => {
  it('未在跑 → { cancelled: false }，不发信号', async () => {
    const call = await load();
    expect(await call('setup:cancel')).toEqual({ success: true, data: { cancelled: false } });
  });

  it('在跑 → SIGTERM 并回 { cancelled: true }', async () => {
    const call = await load();
    expect(await call('setup:start')).toEqual({ success: true, data: { started: true } });
    expect(await call('setup:cancel')).toEqual({ success: true, data: { cancelled: true } });
    expect(env.lastChild!.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('pii.ipc dispatch 特征：抛错兜底', () => {
  it('spawn 同步抛 Error → INTERNAL_ERROR + message，并记带 action 的 error 日志', async () => {
    env.spawn = vi.fn(() => { throw new Error('spawn EACCES'); });
    const call = await load();
    expect(await call('setup:start')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'spawn EACCES' } });
    expect(env.logError).toHaveBeenCalledWith('pii ipc handler error', { action: 'setup:start', error: 'spawn EACCES' });
  });

  it('spawn 抛非 Error → INTERNAL_ERROR + String(error)，日志 error 同为 String', async () => {
    env.spawn = vi.fn(() => { throw 'raw spawn'; });
    const call = await load();
    expect(await call('setup:start')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw spawn' } });
    expect(env.logError).toHaveBeenCalledWith('pii ipc handler error', { action: 'setup:start', error: 'raw spawn' });
  });
});
