import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// hook.ipc.ts 派发特征测试（RQ-183 续作·HOOK 刀迁表前钉住现状）：既有 adminSurfaces.ipc.test.ts 只测非管理员 list 被拦、
// setHookEnabled.test.ts 只测写盘函数本身。这里补齐派发层：管理员门在分发前（未知 action 也先过门）、list 以 app 工作目录
// 构建摘要（缺省 homedir）、openConfigFile 缺参报错 / 补建目录与模板 / 调 shell.openPath、setEnabled 缺参报错与委派写盘、
// revealConfigFolder 缺参报错 / 调 showItemInFolder、管理员下未知 action 的 INVALID_ACTION 'Unknown action:'，
// 以及抛错兜底 INTERNAL_ERROR（Error → message、非 Error → String）。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  accessError: null as null | IPCResponse,
  guardCalls: [] as string[],
  loadAllHooksConfig: vi.fn(),
  mergeHooks: vi.fn(),
  openPath: vi.fn(async (..._a: unknown[]) => ''),
  showItemInFolder: vi.fn(),
  workingDirectory: null as string | null,
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  getAdminAccessIpcError: (feature: string) => {
    h.guardCalls.push(feature);
    return h.accessError;
  },
}));
vi.mock('../../../src/host/hooks/configParser', () => ({
  loadAllHooksConfig: (...a: unknown[]) => h.loadAllHooksConfig(...a),
  getHooksConfigPaths: () => ({ global: [{ path: '/g/hooks.json' }], project: [{ path: '/p/.code-agent/hooks.json' }] }),
  makeHookKey: (event: string, hook: { type: string; command?: string }) => `${event}::${hook.type}::${hook.command ?? ''}`,
}));
vi.mock('../../../src/host/hooks/merger', () => ({ mergeHooks: (...a: unknown[]) => h.mergeHooks(...a) }));
vi.mock('../../../src/host/protocol/events', () => ({
  HOOK_EVENT_DESCRIPTIONS: { Stop: '停止时', SessionStart: '会话开始' },
}));
vi.mock('../../../src/host/platform', () => ({
  shell: { openPath: (...a: unknown[]) => h.openPath(...a), showItemInFolder: (...a: unknown[]) => h.showItemInFolder(...a) },
}));
vi.mock('../../../src/host/config/configPaths', () => ({ CONFIG_DIR_NEW: '.code-agent' }));

import { registerHookHandlers } from '../../../src/host/ipc/hook.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: Handler;
let tmp: string;
const call = (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
const internal = (message: string) => ({ success: false, error: { code: 'INTERNAL_ERROR', message } });

beforeEach(() => {
  vi.clearAllMocks();
  h.accessError = null;
  h.guardCalls.length = 0;
  h.workingDirectory = '/work';
  h.loadAllHooksConfig.mockResolvedValue([]);
  h.mergeHooks.mockReturnValue([]);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-domain-ipc-'));
  const handlers = new Map<string, Handler>();
  registerHookHandlers(
    { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never,
    () => ({ getWorkingDirectory: () => h.workingDirectory }) as never,
  );
  handler = handlers.get(IPC_DOMAINS.HOOK)!;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hook.ipc dispatch 特征：管理员门', () => {
  it('非管理员：任何 action（含未知）都先被门拦下，不读配置', async () => {
    h.accessError = { success: false, error: { code: 'FORBIDDEN', message: 'Hooks requires admin' } };
    expect(await call('list')).toEqual(h.accessError);
    expect(await call('bogus')).toEqual(h.accessError);
    expect(h.guardCalls).toEqual(['Hooks', 'Hooks']);
    expect(h.loadAllHooksConfig).not.toHaveBeenCalled();
  });

  it('管理员：未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });
});

describe('hook.ipc dispatch 特征：list', () => {
  it('以 app 工作目录构建摘要：摊平已注册 hook、列出无人监听的 event、给出配置路径', async () => {
    h.mergeHooks.mockReturnValueOnce([{
      event: 'Stop',
      matcher: /^Bash$/,
      hooks: [{ type: 'command', command: 'notify.sh', disabled: true }],
      sources: ['project'],
      parallel: false,
      hookType: 'observer',
    }]);
    const res = await call('list');
    expect(h.loadAllHooksConfig).toHaveBeenCalledWith('/work');
    expect(res).toEqual({
      success: true,
      data: {
        enabled: [{
          event: 'Stop', description: '停止时', matcher: '^Bash$', type: 'command', hint: 'notify.sh',
          sources: ['project'], hookType: 'observer', parallel: false, disabled: true, key: 'Stop::command::notify.sh',
        }],
        unused: [{ event: 'SessionStart', description: '会话开始' }],
        configPaths: { global: '/g/hooks.json', project: '/p/.code-agent/hooks.json' },
      },
    });
  });

  it('无工作目录：配置从 homedir 读，project 路径为 null', async () => {
    h.workingDirectory = null;
    const res = await call('list');
    expect(h.loadAllHooksConfig).toHaveBeenCalledWith(os.homedir());
    expect((res.data as { configPaths: unknown }).configPaths).toEqual({ global: '/g/hooks.json', project: null });
  });
});

describe('hook.ipc dispatch 特征：文件操作', () => {
  it('openConfigFile：缺 filePath → INTERNAL_ERROR；不存在时补建目录与空模板后打开', async () => {
    expect(await call('openConfigFile', {})).toEqual(internal('Missing filePath'));
    const filePath = path.join(tmp, 'nested', 'hooks.json');
    expect(await call('openConfigFile', { filePath })).toEqual({ success: true, data: { opened: filePath } });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{\n  "hooks": {}\n}\n');
    expect(h.openPath).toHaveBeenCalledWith(filePath);
  });

  it('openConfigFile：已存在的文件不覆盖', async () => {
    const filePath = path.join(tmp, 'hooks.json');
    fs.writeFileSync(filePath, '{"Stop":[]}', 'utf-8');
    await call('openConfigFile', { filePath });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"Stop":[]}');
  });

  it('setEnabled：缺 filePath 或 key → INTERNAL_ERROR；齐全时改写 hooks.json 并回传 matched', async () => {
    expect(await call('setEnabled', { filePath: '/x/hooks.json' })).toEqual(internal('Missing filePath or key'));
    const filePath = path.join(tmp, 'hooks.json');
    fs.writeFileSync(filePath, JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'a.sh' }] }] }), 'utf-8');
    expect(await call('setEnabled', { filePath, key: 'Stop::command::a.sh', enabled: false })).toEqual({ success: true, data: { matched: 1 } });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).Stop[0].hooks[0].disabled).toBe(true);
  });

  it('revealConfigFolder：缺 filePath → INTERNAL_ERROR；payload 缺省时解构即抛（文案含 filePath）；齐全时在 Finder 显示', async () => {
    expect(await call('revealConfigFolder', {})).toEqual(internal('Missing filePath'));
    const noPayload = await call('revealConfigFolder');
    expect(noPayload).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
    expect(noPayload.error?.message).toContain('filePath');
    expect(h.showItemInFolder).not.toHaveBeenCalled();
    expect(await call('revealConfigFolder', { filePath: '/g/hooks.json' })).toEqual({ success: true, data: { revealed: '/g/hooks.json' } });
    expect(h.showItemInFolder).toHaveBeenCalledWith('/g/hooks.json');
  });

  it('抛错兜底：Error → message；非 Error → String(error)', async () => {
    h.loadAllHooksConfig.mockRejectedValueOnce(new Error('bad json'));
    expect(await call('list')).toEqual(internal('bad json'));
    h.loadAllHooksConfig.mockRejectedValueOnce('boom');
    expect(await call('list')).toEqual(internal('boom'));
  });
});
