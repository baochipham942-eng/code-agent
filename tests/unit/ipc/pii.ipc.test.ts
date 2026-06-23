import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// pii.ipc.ts 是 B3「一键启用本地 PII 防线」的 IPC 咽喉：renderer 调 setup:start
// spawn 安装脚本、setup:isReady 校验 env/python/onnx 就位。这里 mock fs/os/spawn
// 把它从真实文件系统与子进程里隔离出来，覆盖派发 / checkReady / startSetup 全路径。

const mockState = vi.hoisted(() => ({
  // fs 行为可调
  existsSync: (_p: string) => true as boolean,
  isFile: true,
  envContent: '',
  homedir: '/home/test',
  // spawn 返回的假 child（含 stdout/stderr EventEmitter 与 kill）
  lastChild: null as null | (EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  }),
  spawn: vi.fn(),
  broadcast: vi.fn(),
}));

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

vi.mock('fs', () => ({
  existsSync: (p: string) => mockState.existsSync(p),
  statSync: () => ({ isFile: () => mockState.isFile }),
  readFileSync: () => mockState.envContent,
}));

vi.mock('os', () => ({
  homedir: () => mockState.homedir,
}));

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockState.spawn(...args),
}));

vi.mock('../../../src/main/platform', () => ({
  broadcastToRenderer: (...args: unknown[]) => mockState.broadcast(...args),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function createMockIpcMain() {
  const handlers = new Map<string, HandlerFn>();
  return {
    handle: (channel: string, fn: HandlerFn) => handlers.set(channel, fn),
    handlers,
  };
}

async function setup() {
  vi.resetModules();
  const { registerPiiHandlers } = await import('../../../src/main/ipc/pii.ipc');
  const ipc = createMockIpcMain();
  registerPiiHandlers(ipc as never);
  const handler = ipc.handlers.get(IPC_DOMAINS.PII)!;
  return { handler };
}

const call = (handler: HandlerFn, action: string) => handler(null, { action } as IPCRequest);

beforeEach(() => {
  mockState.existsSync = () => true;
  mockState.isFile = true;
  mockState.envContent = '';
  mockState.lastChild = null;
  mockState.spawn = vi.fn(() => {
    const child = makeChild();
    mockState.lastChild = child;
    return child;
  });
  mockState.broadcast = vi.fn();
});

describe('registerPiiHandlers — 派发', () => {
  it('注册到 domain:pii', async () => {
    const { handler } = await setup();
    expect(handler).toBeTypeOf('function');
  });

  it('未知 action 返回 INVALID_ACTION', async () => {
    const { handler } = await setup();
    const res = await call(handler, 'nope');
    expect(res).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: nope' } });
  });
});

describe('setup:isReady (checkReady + parseEnvFile)', () => {
  it('env 文件不存在 → 全部未就绪', async () => {
    mockState.existsSync = () => false;
    const { handler } = await setup();
    const res = await call(handler, 'setup:isReady');
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      ready: false,
      envFile: { exists: false, hasPiiKeys: false },
      pythonPath: null,
      modelOnnx: null,
    });
  });

  it('env 齐全且 python/onnx 文件存在 → ready', async () => {
    mockState.envContent = [
      '# 注释行被忽略',
      '',
      'CODE_AGENT_PII_ENTITY_DETECTOR=gliner-onnx-command',
      'CODE_AGENT_GLINER_PII_RUNNER_PYTHON=/venv/bin/python',
      'CODE_AGENT_GLINER_PII_MODEL=/models/gliner',
      'NO_EQUALS_LINE', // indexOf('=')<0 跳过
    ].join('\n');
    mockState.existsSync = () => true;
    const { handler } = await setup();
    const res = await call(handler, 'setup:isReady');
    expect(res.data).toMatchObject({
      ready: true,
      envFile: { exists: true, hasPiiKeys: true },
      pythonPath: '/venv/bin/python',
      modelOnnx: '/models/gliner/onnx/model_quint8.onnx',
    });
  });

  it('detector 不匹配 → hasPiiKeys=false 且 not ready', async () => {
    mockState.envContent = 'CODE_AGENT_PII_ENTITY_DETECTOR=other\nCODE_AGENT_GLINER_PII_RUNNER_PYTHON=/p\nCODE_AGENT_GLINER_PII_MODEL=/m';
    const { handler } = await setup();
    const res = await call(handler, 'setup:isReady');
    expect(res.data).toMatchObject({ ready: false, envFile: { exists: true, hasPiiKeys: false } });
  });

  it('env 齐全但 python 文件缺失 → not ready，pythonPath 归 null', async () => {
    mockState.envContent = 'CODE_AGENT_PII_ENTITY_DETECTOR=gliner-onnx-command\nCODE_AGENT_GLINER_PII_RUNNER_PYTHON=/venv/bin/python\nCODE_AGENT_GLINER_PII_MODEL=/models/gliner';
    // env 文件存在但 python/onnx 路径不存在
    mockState.existsSync = (p: string) => p.endsWith('.env');
    const { handler } = await setup();
    const res = await call(handler, 'setup:isReady');
    expect(res.data).toMatchObject({ ready: false, pythonPath: null, modelOnnx: null });
  });
});

describe('setup:status (getStatus)', () => {
  it('初始 idle，logTail 为空', async () => {
    const { handler } = await setup();
    const res = await call(handler, 'setup:status');
    expect(res.data).toMatchObject({ state: 'idle', startedAt: null, error: null, logTail: [] });
  });
});

describe('setup:start (startSetup)', () => {
  it('bundle 文件缺失 → started:false 带错误', async () => {
    mockState.existsSync = () => false; // findBundledFile 全失败
    const { handler } = await setup();
    const res = await call(handler, 'setup:start');
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ started: false });
    expect((res.data as { error: string }).error).toContain('未找到');
  });

  it('成功 spawn → started:true，状态转 running，并 broadcast', async () => {
    const { handler } = await setup();
    const res = await call(handler, 'setup:start');
    expect(res.data).toEqual({ started: true });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.broadcast).toHaveBeenCalled(); // setState('running') 推事件
    const status = await call(handler, 'setup:status');
    expect(status.data).toMatchObject({ state: 'running' });
  });

  it('已在 running 时再次 start → started:false', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    const again = await call(handler, 'setup:start');
    expect(again.data).toMatchObject({ started: false });
  });

  it('stdout 数据按行进缓冲，close code 0 → completed', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    const child = mockState.lastChild!;
    child.stdout.emit('data', Buffer.from('第一行\n不完整'));
    child.emit('close', 0, null);
    const status = await call(handler, 'setup:status');
    expect(status.data).toMatchObject({ state: 'completed' });
    const tail = (status.data as { logTail: Array<{ line: string }> }).logTail;
    expect(tail.some((l) => l.line === '第一行')).toBe(true);
    // 残留「不完整」在 close 时冲刷
    expect(tail.some((l) => l.line === '不完整')).toBe(true);
  });

  it('close 非 0 退出码 → error 状态', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    mockState.lastChild!.emit('close', 1, null);
    const status = await call(handler, 'setup:status');
    expect(status.data).toMatchObject({ state: 'error' });
    expect((status.data as { error: string }).error).toContain('退出码 1');
  });

  it('child error 事件 → error 状态', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    mockState.lastChild!.emit('error', new Error('boom'));
    const status = await call(handler, 'setup:status');
    expect(status.data).toMatchObject({ state: 'error' });
    expect((status.data as { error: string }).error).toContain('boom');
  });

  it('STEP 行额外 emit step 事件', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    mockState.lastChild!.stdout.emit('data', Buffer.from('▷ STEP: 下载模型\n'));
    const stepEvents = mockState.broadcast.mock.calls.filter(
      ([, ev]) => (ev as { type: string }).type === 'step',
    );
    expect(stepEvents.length).toBeGreaterThanOrEqual(1);
    expect((stepEvents[0][1] as { description: string }).description).toBe('下载模型');
  });

  it('uv binary 缺失 → started:false', async () => {
    mockState.existsSync = (p: string) => !/uv(\.exe)?$/.test(p); // uv 缺失，其余存在
    const { handler } = await setup();
    const res = await call(handler, 'setup:start');
    expect((res.data as { error: string }).error).toContain('uv binary');
  });

  it('runner 脚本缺失 → started:false', async () => {
    mockState.existsSync = (p: string) => !p.endsWith('gliner_onnx_runner.py');
    const { handler } = await setup();
    const res = await call(handler, 'setup:start');
    expect((res.data as { error: string }).error).toContain('gliner_onnx_runner.py');
  });

  it('被 SIGTERM 取消 → error 状态标记取消', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    mockState.lastChild!.emit('close', null, 'SIGTERM');
    const status = await call(handler, 'setup:status');
    expect((status.data as { error: string }).error).toContain('取消');
  });
});

describe('setup:cancel (cancelSetup)', () => {
  it('无运行任务 → cancelled:false', async () => {
    const { handler } = await setup();
    const res = await call(handler, 'setup:cancel');
    expect(res.data).toEqual({ cancelled: false });
  });

  it('运行中 → kill 子进程并 cancelled:true', async () => {
    const { handler } = await setup();
    await call(handler, 'setup:start');
    const child = mockState.lastChild!;
    const res = await call(handler, 'setup:cancel');
    expect(res.data).toEqual({ cancelled: true });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('handler 异常兜底', () => {
  it('内部抛错 → INTERNAL_ERROR', async () => {
    const { handler } = await setup();
    // 让 spawn 抛错触发 catch
    mockState.spawn = vi.fn(() => {
      throw new Error('spawn failed');
    });
    const res = await call(handler, 'setup:start');
    expect(res).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'spawn failed' } });
  });
});
