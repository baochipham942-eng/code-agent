import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// agentRegistry.ipc.ts 派发特征测试（RQ-183 续作·AGENT_REGISTRY 刀迁表前钉住 switch 形态；派发层原本零测试）：domain:agents 派发层 1 个 action（计数以切块断言为准）。
// - list 回 listAllAgentsWithRoleFlag() 结果
// - 未知 action → UNKNOWN_ACTION + `Unknown agents action: <action>`
// - 抛错 → 记 ('AgentRegistry IPC error', error) + AGENT_REGISTRY_ERROR；Error 取 message、非 Error 为 'Unknown error'
// - 注册期挂 onAgentRegistryChange：变更时向未销毁窗口推 AGENTS_CHANGED { agents }，已销毁窗口跳过；取列表抛错只 warn 不冒泡
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<unknown> => [{ id: 'coder', isRole: true }]),
  changeCb: null as null | (() => void),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../../src/host/agent/agentRegistry', () => ({
  listAllAgentsWithRoleFlag: () => h.list(),
  onAgentRegistryChange: (cb: () => void) => { h.changeCb = cb; },
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.logWarn, error: h.logError, debug: vi.fn() }),
}));

import { registerAgentRegistryHandlers } from '../../../src/host/ipc/agentRegistry.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;
let windows: Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>;

beforeEach(() => {
  vi.clearAllMocks();
  h.changeCb = null;
  windows = [
    { isDestroyed: () => false, webContents: { send: vi.fn() } },
    { isDestroyed: () => true, webContents: { send: vi.fn() } },
  ];
  const handlers = new Map<string, HandlerFn>();
  registerAgentRegistryHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never, () => windows as never);
  const handler = handlers.get(IPC_DOMAINS.AGENT_REGISTRY)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('agentRegistry.ipc dispatch 特征', () => {
  it('list 回列表', async () => {
    expect(await call('list')).toEqual({ success: true, data: [{ id: 'coder', isRole: true }] });
  });

  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown agents action: bogus' } });
  });

  it('抛 Error → AGENT_REGISTRY_ERROR + message 并记日志；抛非 Error → Unknown error', async () => {
    const err = new Error('scan failed');
    h.list.mockRejectedValueOnce(err);
    expect(await call('list')).toEqual({ success: false, error: { code: 'AGENT_REGISTRY_ERROR', message: 'scan failed' } });
    expect(h.logError).toHaveBeenCalledWith('AgentRegistry IPC error', err);
    h.list.mockRejectedValueOnce('raw');
    expect(await call('list')).toEqual({ success: false, error: { code: 'AGENT_REGISTRY_ERROR', message: 'Unknown error' } });
  });
});

describe('agentRegistry.ipc 注册期广播', () => {
  it('变更时向未销毁窗口推 AGENTS_CHANGED，已销毁跳过', async () => {
    h.changeCb!();
    await flush();
    expect(windows[0].webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.AGENTS_CHANGED, { agents: [{ id: 'coder', isRole: true }] });
    expect(windows[1].webContents.send).not.toHaveBeenCalled();
  });

  it('广播取列表抛错只 warn 不冒泡', async () => {
    h.list.mockRejectedValueOnce(new Error('boom'));
    h.changeCb!();
    await flush();
    expect(h.logWarn).toHaveBeenCalledWith('Failed to broadcast agents:changed', { error: 'Error: boom' });
    expect(windows[0].webContents.send).not.toHaveBeenCalled();
  });
});
