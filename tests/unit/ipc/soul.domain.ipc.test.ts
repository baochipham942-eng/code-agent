import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// soul.ipc.ts 派发特征测试（RQ-183 续作·SOUL 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 5 个 action（计数以切块断言为准）。
// - getStatus：project PROFILE.md 存在 → project；否则用户 SOUL.md 存在 → user；都无 → builtin；length 取 getSoul() 长度；workingDirectory 非字符串忽略
// - getProfile：scope=project 且有 wd 读项目 PROFILE.md，否则读用户 SOUL.md；文件不存在 content 为空串
// - saveProfile：目录不存在先 mkdir（recursive），写文件后以 wd 重载 soul，回 filePath
// - getDefault：回内置 IDENTITY
// - resetProfile：文件存在才删，随后以 wd 重载 soul，回 filePath
// - 未知 action → UNKNOWN_ACTION + `Unknown soul action: <action>`；抛错 → 记 ('Soul IPC error:', error) + SOUL_ERROR，非 Error 为 'Unknown error'
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  existing: new Set<string>(),
  files: new Map<string, string>(),
  fs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  loadSoul: vi.fn(),
  getSoul: vi.fn((): string => 'soul-text'),
  logError: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (p: string) => h.fs.existsSync(p),
  readFileSync: (p: string, enc: string) => h.fs.readFileSync(p, enc),
  writeFileSync: (p: string, c: string, enc: string) => h.fs.writeFileSync(p, c, enc),
  mkdirSync: (p: string, o: unknown) => h.fs.mkdirSync(p, o),
  unlinkSync: (p: string) => h.fs.unlinkSync(p),
}));
vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/prompts/soulLoader', () => ({
  loadSoul: (wd?: string) => h.loadSoul(wd),
  getSoul: () => h.getSoul(),
}));
vi.mock('../../../src/host/prompts/identity', () => ({ IDENTITY: 'BUILTIN-IDENTITY' }));
vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => '/home/u/.code-agent',
  getProjectConfigDir: (wd: string) => `${wd}/.code-agent`,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerSoulHandlers } from '../../../src/host/ipc/soul.ipc';

const USER_SOUL = path.join('/home/u/.code-agent', 'SOUL.md');
const PROJ_PROFILE = path.join('/w/.code-agent', 'PROFILE.md');
const call = (action: string, payload?: unknown) => h.handlers.get(IPC_DOMAINS.SOUL)!(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.existing = new Set();
  h.files = new Map();
  h.getSoul.mockReturnValue('soul-text');
  h.fs.existsSync.mockImplementation((p: string) => h.existing.has(p));
  h.fs.readFileSync.mockImplementation((p: string) => h.files.get(p) ?? '');
  registerSoulHandlers();
});

describe('soul.ipc dispatch 特征：getStatus', () => {
  it('来源优先级 project > user > builtin，length 取 getSoul 长度，非字符串 wd 忽略', async () => {
    expect(await call('getStatus', { workingDirectory: 42 })).toEqual({ success: true, data: { source: 'builtin', length: 9 } });
    h.existing.add(USER_SOUL);
    expect(await call('getStatus')).toEqual({ success: true, data: { source: 'user', length: 9 } });
    h.existing.add(PROJ_PROFILE);
    expect(await call('getStatus', { workingDirectory: '/w' })).toEqual({ success: true, data: { source: 'project', length: 9 } });
  });
});

describe('soul.ipc dispatch 特征：profile 读写', () => {
  it('getProfile：project+wd 读项目文件，否则读用户文件；不存在为空串', async () => {
    h.existing.add(PROJ_PROFILE); h.files.set(PROJ_PROFILE, 'proj');
    expect(await call('getProfile', { scope: 'project', workingDirectory: '/w' })).toEqual({ success: true, data: { content: 'proj', filePath: PROJ_PROFILE } });
    expect(await call('getProfile', { scope: 'project' })).toEqual({ success: true, data: { content: '', filePath: USER_SOUL } });
  });

  it('saveProfile：目录缺失先 mkdir，写文件并以 wd 重载 soul', async () => {
    expect(await call('saveProfile', { scope: 'project', content: 'C', workingDirectory: '/w' })).toEqual({ success: true, data: { filePath: PROJ_PROFILE } });
    expect(h.fs.mkdirSync).toHaveBeenCalledWith('/w/.code-agent', { recursive: true });
    expect(h.fs.writeFileSync).toHaveBeenCalledWith(PROJ_PROFILE, 'C', 'utf-8');
    expect(h.loadSoul).toHaveBeenCalledWith('/w');
    h.existing.add('/home/u/.code-agent');
    expect(await call('saveProfile', { scope: 'user', content: 'U' })).toEqual({ success: true, data: { filePath: USER_SOUL } });
    expect(h.fs.mkdirSync).toHaveBeenCalledTimes(1);
    expect(h.loadSoul).toHaveBeenLastCalledWith(undefined);
  });

  it('getDefault 回内置 IDENTITY；resetProfile 存在才删并重载', async () => {
    expect(await call('getDefault')).toEqual({ success: true, data: { content: 'BUILTIN-IDENTITY' } });
    expect(await call('resetProfile', { scope: 'user' })).toEqual({ success: true, data: { filePath: USER_SOUL } });
    expect(h.fs.unlinkSync).not.toHaveBeenCalled();
    h.existing.add(PROJ_PROFILE);
    expect(await call('resetProfile', { scope: 'project', workingDirectory: '/w' })).toEqual({ success: true, data: { filePath: PROJ_PROFILE } });
    expect(h.fs.unlinkSync).toHaveBeenCalledWith(PROJ_PROFILE);
    expect(h.loadSoul).toHaveBeenLastCalledWith('/w');
  });
});

describe('soul.ipc dispatch 特征：兜底', () => {
  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown soul action: bogus' } });
  });

  it('抛 Error → SOUL_ERROR + message 并记日志；抛非 Error → Unknown error', async () => {
    const err = new Error('disk full');
    h.fs.writeFileSync.mockImplementationOnce(() => { throw err; });
    expect(await call('saveProfile', { scope: 'user', content: 'x' })).toEqual({ success: false, error: { code: 'SOUL_ERROR', message: 'disk full' } });
    expect(h.logError).toHaveBeenCalledWith('Soul IPC error:', err);
    h.getSoul.mockImplementationOnce(() => { throw 'raw'; });
    expect(await call('getStatus')).toEqual({ success: false, error: { code: 'SOUL_ERROR', message: 'Unknown error' } });
  });
});
