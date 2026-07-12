/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// B1 ②「新会话默认权限档」+ 会话档切换（单一真源 + 广播）测试
// ============================================================================
// - 新会话按默认档快照建档，改默认档不影响已有会话
// - 会话内切换：写 PermissionModeManager（唯一真源）并广播，无 pending 中转 state
// - 设置页默认档：直接写 settings 并广播

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// 会话档持久化（B1 审出 MED 修复）落 CODE_AGENT_DATA_DIR：测试指到临时目录，
// 不污染真实用户目录；每个用例前清掉持久化文件，避免跨用例泄漏。
const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1-session-modes-'));
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
beforeEach(() => {
  fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
});
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const env = vi.hoisted(() => ({
  broadcasts: [] as Array<{ channel: string; data: unknown }>,
  updateSettings: vi.fn(async () => {}),
  // 模拟 admin 门：null=admin 放行；非 null=非 admin，返回 FORBIDDEN IPC error
  adminIpcError: null as { success: false; error: { code: string; message: string } } | null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '0.0.0-test' },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: (channel: string, data: unknown) => {
    env.broadcasts.push({ channel, data });
  },
}));

// settings.ipc 模块级依赖
vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => env.adminIpcError,
  assertAdminAccess: vi.fn(),
}));
vi.mock('../../../src/host/model/providerConnectionTest', () => ({
  resolveConnectionTestModel: () => 'test-model',
}));
vi.mock('../../../src/host/services/providerIconAssets', () => ({
  saveProviderIconAsset: vi.fn(),
  resolveProviderIconAsset: vi.fn(),
}));
vi.mock('../../../src/shared/modelRuntime', () => ({
  isRuntimeProviderConfigured: () => false,
}));
vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    get: vi.fn(),
    set: vi.fn(),
    getStoredApiKeyProviders: () => [],
  }),
}));
vi.mock('../../../src/host/services/core/budgetService', () => ({
  getBudgetService: () => ({}),
  syncBudgetServiceFromConfig: vi.fn(),
}));

import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../../src/host/permissions/modes';
import { registerAgentHandlers } from '../../../src/host/ipc/agent.ipc';
import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';

type DomainHandler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
type ChannelHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function captureHandlers() {
  const handlers = new Map<string, ChannelHandler>();
  const ipcMain = {
    handle: (channel: string, fn: ChannelHandler) => handlers.set(channel, fn),
    on: vi.fn(),
    removeHandler: vi.fn(),
  } as never;
  return { handlers, ipcMain };
}

describe('PermissionModeManager 会话档语义', () => {
  beforeEach(() => resetPermissionModeManager());
  afterEach(() => resetPermissionModeManager());

  it('新会话按当前默认档快照，之后改默认档不影响已有会话', () => {
    const manager = getPermissionModeManager();
    manager.setMode('acceptEdits');
    manager.initSessionMode('s1');
    manager.setMode('default'); // 改「新会话默认档」
    expect(manager.getModeForSession('s1')).toBe('acceptEdits'); // 已有会话不漂移
    manager.initSessionMode('s2');
    expect(manager.getModeForSession('s2')).toBe('default'); // 新会话吃到新默认档
  });

  it('会话内切换覆盖会话档；无档会话回退全局默认', () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode('s1');
    expect(manager.setSessionMode('s1', 'readOnly')).toBe(true);
    expect(manager.getModeForSession('s1')).toBe('readOnly');
    expect(manager.getModeForSession('unknown-session')).toBe('default');
  });

  it('会话内显式切档跨重启持久：重启后不再静默回退全局默认档（审出 MED）', () => {
    const manager = getPermissionModeManager();
    manager.setMode('acceptEdits'); // 全局默认档 ≠ 会话选档，回退时会被拆穿
    manager.initSessionMode('s1');
    manager.setSessionMode('s1', 'readOnly');
    resetPermissionModeManager(); // 模拟应用重启：进程内存清空，从磁盘装载
    const reborn = getPermissionModeManager();
    expect(reborn.getModeForSession('s1')).toBe('readOnly');
  });

  it('未显式切档的会话重启后回退全局默认档（快照不落盘的已知上限）', () => {
    const manager = getPermissionModeManager();
    manager.setMode('acceptEdits');
    manager.initSessionMode('s1'); // 只有创建期快照，无显式选择
    resetPermissionModeManager();
    expect(getPermissionModeManager().getModeForSession('s1')).toBe('default');
  });

  it('bypassPermissions 会话档未审批时拒绝', () => {
    const manager = getPermissionModeManager();
    expect(manager.setSessionMode('s1', 'bypassPermissions', false)).toBe(false);
    expect(manager.getModeForSession('s1')).toBe('default');
    expect(manager.setSessionMode('s1', 'bypassPermissions', true)).toBe(true);
    expect(manager.getModeForSession('s1')).toBe('bypassPermissions');
  });
});

describe('agent.ipc 会话档读写 + 广播（单一真源）', () => {
  let handlers: Map<string, ChannelHandler>;

  beforeEach(() => {
    resetPermissionModeManager();
    env.broadcasts.length = 0;
    env.adminIpcError = null;
    const cap = captureHandlers();
    handlers = cap.handlers;
    registerAgentHandlers(cap.ipcMain, () => null);
  });

  afterEach(() => {
    env.adminIpcError = null;
    resetPermissionModeManager();
  });

  const callAgent = (action: string, payload?: unknown) =>
    (handlers.get(IPC_DOMAINS.AGENT) as DomainHandler)(null, { action, payload } as IPCRequest);

  it('setSessionPermissionMode 写入真源并广播，getSessionPermissionMode 读回同值', async () => {
    const setRes = await callAgent('setSessionPermissionMode', { sessionId: 's1', mode: 'readOnly' });
    expect(setRes.success).toBe(true);
    expect((setRes.data as { mode: string }).mode).toBe('readOnly');

    // 真源立即可读（无 pending 中转 state）
    expect(getPermissionModeManager().getModeForSession('s1')).toBe('readOnly');
    const getRes = await callAgent('getSessionPermissionMode', { sessionId: 's1' });
    expect((getRes.data as { mode: string }).mode).toBe('readOnly');

    // 广播同步给所有消费方
    const broadcast = env.broadcasts.find((b) => b.channel === IPC_CHANNELS.PERMISSION_MODE_CHANGED);
    expect(broadcast).toBeTruthy();
    expect(broadcast!.data).toMatchObject({ scope: 'session', sessionId: 's1', mode: 'readOnly' });
  });

  it('非法 mode / 缺 sessionId 拒绝且不广播', async () => {
    const bad = await callAgent('setSessionPermissionMode', { sessionId: 's1', mode: 'full_access' });
    expect(bad.success).toBe(false);
    const noSession = await callAgent('setSessionPermissionMode', { mode: 'readOnly' });
    expect(noSession.success).toBe(false);
    expect(env.broadcasts.filter((b) => b.channel === IPC_CHANNELS.PERMISSION_MODE_CHANGED)).toHaveLength(0);
  });

  it('非 admin 提档到 bypassPermissions 被 FORBIDDEN，approved 自报不作数（审出 MED）', async () => {
    env.adminIpcError = { success: false, error: { code: 'FORBIDDEN', message: 'Session permission mode: Admin permission required' } };
    const res = await callAgent('setSessionPermissionMode', { sessionId: 's1', mode: 'bypassPermissions', approved: true });
    expect(res.success).toBe(false);
    expect((res.error as { code: string }).code).toBe('FORBIDDEN');
    // 真源未被污染，也不广播
    expect(getPermissionModeManager().getModeForSession('s1')).toBe('default');
    expect(env.broadcasts.filter((b) => b.channel === IPC_CHANNELS.PERMISSION_MODE_CHANGED)).toHaveLength(0);
    // 全局 setPermissionMode 同口径过门
    const globalRes = await callAgent('setPermissionMode', { mode: 'bypassPermissions', approved: true });
    expect(globalRes.success).toBe(false);
    expect((globalRes.error as { code: string }).code).toBe('FORBIDDEN');
    expect(getPermissionModeManager().getMode()).toBe('default');
  });

  it('非 admin 切普通档不受 admin 门影响；admin 提 bypass 照常成功', async () => {
    env.adminIpcError = { success: false, error: { code: 'FORBIDDEN', message: 'nope' } };
    const normal = await callAgent('setSessionPermissionMode', { sessionId: 's1', mode: 'acceptEdits' });
    expect(normal.success).toBe(true);
    expect(getPermissionModeManager().getModeForSession('s1')).toBe('acceptEdits');

    env.adminIpcError = null; // admin
    const bypass = await callAgent('setSessionPermissionMode', { sessionId: 's1', mode: 'bypassPermissions', approved: true });
    expect(bypass.success).toBe(true);
    expect(getPermissionModeManager().getModeForSession('s1')).toBe('bypassPermissions');
  });
});

describe('settings.ipc 默认档写入 + 广播', () => {
  let handlers: Map<string, ChannelHandler>;

  beforeEach(() => {
    resetPermissionModeManager();
    env.broadcasts.length = 0;
    env.updateSettings.mockClear();
    const cap = captureHandlers();
    handlers = cap.handlers;
    registerSettingsHandlers(cap.ipcMain, () => ({
      getSettings: () => ({}),
      updateSettings: env.updateSettings,
    }) as never);
  });

  afterEach(() => resetPermissionModeManager());

  it('PERMISSION_SET_MODE 直接写 settings 并广播 default 档变更', async () => {
    const handler = handlers.get(IPC_CHANNELS.PERMISSION_SET_MODE)!;
    const ok = await handler(null, 'readOnly');
    expect(ok).toBe(true);

    // 真源（manager）与持久化（settings）同步写入
    expect(getPermissionModeManager().getMode()).toBe('readOnly');
    expect(env.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { permissionMode: 'readOnly' } }),
    );

    const broadcast = env.broadcasts.find((b) => b.channel === IPC_CHANNELS.PERMISSION_MODE_CHANGED);
    expect(broadcast).toBeTruthy();
    expect(broadcast!.data).toMatchObject({ scope: 'default', mode: 'readOnly' });
  });

  it('非法 mode 不写不广播', async () => {
    const handler = handlers.get(IPC_CHANNELS.PERMISSION_SET_MODE)!;
    const ok = await handler(null, 'full_access');
    expect(ok).toBe(false);
    expect(env.updateSettings).not.toHaveBeenCalled();
    expect(env.broadcasts).toHaveLength(0);
  });
});
