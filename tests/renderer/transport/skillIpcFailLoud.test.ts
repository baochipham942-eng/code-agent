// ============================================================================
// skill IPC fail-loud —— 真跑 httpTransport + invokeSkillIPC 两层（fault-injection）
// ============================================================================
// 背景（2026-07-27 产品负责人实测）：transport 对非 2xx 静默 return undefined，
// invokeSkillIPC 再吞一层 → UI 一律显示「添加失败」，后台未就绪 / token 失效 /
// 通道未注册长得一模一样。这里注入 404 / 500 / {success:false} / fetch 异常，
// 断言动作路径能拿到真因，只读路径仍安静兜底。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));

vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

(globalThis as Record<string, unknown>).window = {
  __CODE_AGENT_TOKEN__: 'test-token',
};

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import {
  describeSkillIpcError,
  invokeSkillIPC,
  invokeSkillIPCOrThrow,
} from '../../../src/renderer/services/invokeSkillIPC';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';

function installTransport(): void {
  (globalThis as Record<string, unknown>).window = {
    __CODE_AGENT_TOKEN__: 'test-token',
    codeAgentAPI: createHttpCodeAgentAPI('http://localhost:8181'),
  };
}

function mockFetchOnce(response: Partial<Response> & { body?: unknown }): void {
  (globalThis as Record<string, unknown>).fetch = vi.fn(async () => response);
}

describe('skill IPC fail-loud', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    installTransport();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('通道未注册（404）时动作路径抛出真因，而不是静默 undefined', async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Unknown channel: skill:repo:stage' }),
      headers: new Headers(),
    } as unknown as Response);

    await expect(
      invokeSkillIPCOrThrow(SKILL_CHANNELS.REPO_STAGE, 'https://github.com/foo/bar'),
    ).rejects.toThrow(/Unknown channel: skill:repo:stage/);
  });

  it('handler 抛错（500）时动作路径带出服务端消息', async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'skill service not initialized' } }),
      headers: new Headers(),
    } as unknown as Response);

    await expect(
      invokeSkillIPCOrThrow(SKILL_CHANNELS.REPO_CONFIRM, 'stage-1'),
    ).rejects.toThrow(/skill service not initialized/);
  });

  it('2xx 但 {success:false} 也算失败，不当成空数据吞掉', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: false, error: { message: 'repo already registered' } }),
      text: async () => '',
    } as unknown as Response);

    await expect(
      invokeSkillIPCOrThrow(SKILL_CHANNELS.REPO_ADD_CUSTOM, 'https://github.com/foo/bar'),
    ).rejects.toThrow(/repo already registered/);
  });

  it('fetch 异常（后台还没起来）也抛，不再退化成通用失败', async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });

    await expect(
      invokeSkillIPCOrThrow(SKILL_CHANNELS.REPO_REMOVE, 'repo-1'),
    ).rejects.toThrow(/Failed to fetch/);
  });

  it('只读路径保持安静兜底，且不会把失败记录泄漏给下一次动作调用', async () => {
    mockFetchOnce({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'warming up' }),
      headers: new Headers(),
    } as unknown as Response);

    await expect(invokeSkillIPC(SKILL_CHANNELS.REGISTRY_LIST)).resolves.toBeUndefined();

    // 同通道随后成功：不能再抛上一次的失败
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, data: { items: [] } }),
      text: async () => '',
    } as unknown as Response);

    await expect(invokeSkillIPCOrThrow(SKILL_CHANNELS.REGISTRY_LIST)).resolves.toEqual({ items: [] });
  });

  it('describeSkillIpcError 有真因就带上，没有才退回兜底文案', () => {
    expect(describeSkillIpcError(new Error('repo not found'), '添加失败')).toBe('添加失败：repo not found');
    expect(describeSkillIpcError(new Error('   '), '添加失败')).toBe('添加失败');
    expect(describeSkillIpcError(undefined, '添加失败')).toBe('添加失败');
  });
});
