import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import type { Connector } from '../../../src/host/connectors/base';

// cron.ipc.ts 的 CRON domain dispatch 特征测试（RQ-183 续作·CRON 刀迁表前先钉住现状）：
// 9 个 action 的委派与参数解析、缺参统一 CRON_ERROR 文案、generateFromPrompt 的
// INVALID_INPUT / PARSE_ERROR 分支与模型调用形状、未知 action 的 UNKNOWN_ACTION 契约、
// 抛错兜底 CRON_ERROR + 日志。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  chat: vi.fn(async (..._a: unknown[]) => ({ content: '{"name":"日报"}' as string | undefined })),
  service: {
    getGroupListenCheck: vi.fn((..._a: unknown[]) => ({ status: 'waiting' })),
    listJobs: vi.fn((..._a: unknown[]) => ['job']),
    createJob: vi.fn(async (..._a: unknown[]) => ({ id: 'j1' })),
    updateJob: vi.fn(async (..._a: unknown[]) => ({ id: 'j1', updated: true })),
    grantLoginPassThrough: vi.fn(async (..._a: unknown[]) => ({ id: 'j1', granted: true })),
    deleteJob: vi.fn(async (..._a: unknown[]) => true),
    triggerJob: vi.fn(async (..._a: unknown[]) => ({ executionId: 'e1' })),
    getJobExecutions: vi.fn((..._a: unknown[]) => ['exec']),
    getRecentExecutions: vi.fn((..._a: unknown[]) => ['recent']),
    getStats: vi.fn(() => ({ total: 3 })),
  },
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/cron/cronService', () => ({ getCronService: () => h.service }));
vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    chat(...a: unknown[]) {
      return h.chat(...a);
    }
  },
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.logWarn, error: h.logError, debug: vi.fn() }),
}));

import { registerCronHandlers } from '../../../src/host/ipc/cron.ipc';

const call = (action: string, payload?: unknown) =>
  h.handlers.get(IPC_DOMAINS.CRON)!(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.chat.mockImplementation(async () => ({ content: '{"name":"日报"}' }));
  registerCronHandlers();
});

describe('任务管理委派', () => {
  it('listJobs：只认布尔 enabled 与全字符串 tags；非对象 payload → 不传过滤', async () => {
    expect(await call('listJobs', { filter: { enabled: true, tags: ['a', 'b'], extra: 1 } })).toEqual({ success: true, data: ['job'] });
    expect(h.service.listJobs).toHaveBeenLastCalledWith({ enabled: true, tags: ['a', 'b'] });
    await call('listJobs', { filter: { enabled: 'yes', tags: ['a', 2] } });
    expect(h.service.listJobs).toHaveBeenLastCalledWith({});
    await call('listJobs');
    expect(h.service.listJobs).toHaveBeenLastCalledWith(undefined);
  });

  it('createJob：非对象 payload → CRON_ERROR；对象原样透传', async () => {
    expect(await call('createJob', 'nope')).toEqual({ success: false, error: { code: 'CRON_ERROR', message: 'Invalid cron job payload' } });
    expect(await call('createJob', { name: 'x' })).toEqual({ success: true, data: { id: 'j1' } });
    expect(h.service.createJob).toHaveBeenCalledWith({ name: 'x' });
  });

  it('updateJob：缺 jobId 或 updates 非对象 → CRON_ERROR；成功透传 (jobId, updates)', async () => {
    const invalid = { success: false, error: { code: 'CRON_ERROR', message: 'Invalid cron job update payload' } };
    expect(await call('updateJob', { updates: {} })).toEqual(invalid);
    expect(await call('updateJob', { jobId: 'j1', updates: 'x' })).toEqual(invalid);
    expect(await call('updateJob', { jobId: 'j1', updates: { enabled: false } })).toEqual({ success: true, data: { id: 'j1', updated: true } });
    expect(h.service.updateJob).toHaveBeenCalledWith('j1', { enabled: false });
  });

  it('grantLoginPassThrough：需要 jobId + siteOrigin，并走独立服务动作', async () => {
    expect(await call('grantLoginPassThrough', { jobId: 'j1' })).toEqual({
      success: false,
      error: { code: 'CRON_ERROR', message: 'Invalid cron login pass-through origin' },
    });
    expect(await call('grantLoginPassThrough', { siteOrigin: 'https://example.test' })).toEqual({
      success: false,
      error: { code: 'CRON_ERROR', message: 'Invalid cron job id' },
    });
    expect(await call('grantLoginPassThrough', { jobId: 'j1', siteOrigin: 'https://example.test/path' })).toEqual({
      success: true,
      data: { id: 'j1', granted: true },
    });
    expect(h.service.grantLoginPassThrough).toHaveBeenCalledWith('j1', 'https://example.test/path');
  });

  it.each(['deleteJob', 'triggerJob', 'getExecutions', 'getGroupListenCheck', 'startGroupListenCheck'])('%s：缺 jobId → CRON_ERROR Invalid cron job id', async (action) => {
    expect(await call(action, {})).toEqual({ success: false, error: { code: 'CRON_ERROR', message: 'Invalid cron job id' } });
  });

  it('deleteJob / triggerJob / getExecutions / getRecentExecutions / getStats：透传参数，limit 只认数字', async () => {
    expect(await call('deleteJob', { jobId: 'j1' })).toEqual({ success: true, data: true });
    expect(await call('triggerJob', { jobId: 'j1' })).toEqual({ success: true, data: { executionId: 'e1' } });
    expect(await call('getExecutions', { jobId: 'j1', limit: 5 })).toEqual({ success: true, data: ['exec'] });
    expect(h.service.getJobExecutions).toHaveBeenLastCalledWith('j1', 5);
    await call('getExecutions', { jobId: 'j1', limit: '5' });
    expect(h.service.getJobExecutions).toHaveBeenLastCalledWith('j1', undefined);
    expect(await call('getRecentExecutions', { limit: 20 })).toEqual({ success: true, data: ['recent'] });
    expect(h.service.getRecentExecutions).toHaveBeenLastCalledWith(20);
    expect(await call('getStats')).toEqual({ success: true, data: { total: 3 } });
  });
});

describe('generateFromPrompt', () => {
  it('空白/缺 prompt → INVALID_INPUT，不调模型', async () => {
    const invalid = { success: false, error: { code: 'INVALID_INPUT', message: '请输入任务描述' } };
    expect(await call('generateFromPrompt', { prompt: '   ' })).toEqual(invalid);
    expect(await call('generateFromPrompt', {})).toEqual(invalid);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('成功：默认 provider/model、maxTokens 1024、用户输入 trim、system 带当前时间锚点；从回复中抠出 JSON', async () => {
    h.chat.mockResolvedValueOnce({ content: '好的：{"name":"每日简报","enabled":true} 以上' });
    expect(await call('generateFromPrompt', { prompt: '  每天早上八点给我简报  ' })).toEqual({ success: true, data: { name: '每日简报', enabled: true } });
    const req = h.chat.mock.calls[0][0] as { provider: string; model: string; maxTokens: number; messages: Array<{ role: string; content: string }> };
    expect(req.provider).toBe(DEFAULT_PROVIDER);
    expect(req.model).toBe(DEFAULT_MODEL);
    expect(req.maxTokens).toBe(1024);
    expect(req.messages[1]).toEqual({ role: 'user', content: '每天早上八点给我简报' });
    expect(req.messages[0].role).toBe('system');
    expect(req.messages[0].content).toContain('【当前时间】');
    expect(req.messages[0].content).toContain('"restatement"');
  });

  it('回复里没有 JSON → PARSE_ERROR 格式异常；JSON 解析失败 → PARSE_ERROR 解析失败；content 缺省按空串', async () => {
    h.chat.mockResolvedValueOnce({ content: '我没法生成' });
    expect(await call('generateFromPrompt', { prompt: 'x' })).toEqual({ success: false, error: { code: 'PARSE_ERROR', message: 'AI 返回格式异常，请重试或换个描述方式' } });
    h.chat.mockResolvedValueOnce({ content: '{name: 不是合法 JSON}' });
    expect(await call('generateFromPrompt', { prompt: 'x' })).toEqual({ success: false, error: { code: 'PARSE_ERROR', message: 'AI 返回的 JSON 解析失败，请重试' } });
    h.chat.mockResolvedValueOnce({ content: undefined });
    expect(await call('generateFromPrompt', { prompt: 'x' })).toEqual({ success: false, error: { code: 'PARSE_ERROR', message: 'AI 返回格式异常，请重试或换个描述方式' } });
  });

  it('模型调用抛错 → CRON_ERROR + 日志', async () => {
    h.chat.mockRejectedValueOnce(new Error('model down'));
    expect(await call('generateFromPrompt', { prompt: 'x' })).toEqual({ success: false, error: { code: 'CRON_ERROR', message: 'model down' } });
    expect(h.logError).toHaveBeenCalledWith('Cron IPC error:', expect.any(Error));
  });
});

describe('dispatch 兜底', () => {
  it('未知 action → UNKNOWN_ACTION + Unknown cron action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown cron action: bogus' } });
  });

  it('服务抛 Error → CRON_ERROR + message + 日志；非 Error → Unknown error', async () => {
    h.service.getStats.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    expect(await call('getStats')).toEqual({ success: false, error: { code: 'CRON_ERROR', message: 'db locked' } });
    expect(h.logError).toHaveBeenCalledWith('Cron IPC error:', expect.any(Error));
    h.service.getStats.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call('getStats')).toEqual({ success: false, error: { code: 'CRON_ERROR', message: 'Unknown error' } });
  });
});

it('routes receipt checks without executing the cron task', async () => {
  expect(await call('getGroupListenCheck', { jobId: 'j1' })).toEqual({ success: true, data: { status: 'waiting' } });
  expect(h.service.getGroupListenCheck).toHaveBeenLastCalledWith('j1');
  expect(await call('startGroupListenCheck', { jobId: 'j1' })).toEqual({ success: true, data: { status: 'waiting' } });
  expect(h.service.getGroupListenCheck).toHaveBeenLastCalledWith('j1', true);
  expect(h.service.triggerJob).not.toHaveBeenCalled();
});

// ============================================================================
// listMailSources（N-TRIGGER-MAIL-CREATE-ENTRY-K1）：mail 触发源的账号/邮箱目录。
// 失败分类与 createDefaultMailReader 同构，四个 reason 可区分且每个非 ok 分支
// 都带 reason 记 warn 日志（降级留痕）。
// ============================================================================
describe('listMailSources', () => {
  const registry = getConnectorRegistry();

  function registerMailConnector(connector: Partial<Connector> & Pick<Connector, 'execute'>): void {
    registry.register({
      id: 'mail',
      label: 'Mail',
      capabilities: ['list_accounts', 'list_mailboxes'],
      getCachedStatus: () => ({ connected: false, readiness: 'unchecked', capabilities: [] }),
      getStatus: async () => ({ connected: false, readiness: 'unchecked', capabilities: [] }),
      ...connector,
    });
  }

  afterEach(() => {
    registry.unregister('mail');
  });

  it('未注册（设置里没启用）→ ok:false connector-not-enabled，日志带 reason', async () => {
    expect(await call('listMailSources')).toEqual({
      success: true,
      data: { ok: false, reason: 'connector-not-enabled' },
    });
    expect(h.logWarn.mock.calls.some((args) => String(args[0]).includes('connector-not-enabled'))).toBe(true);
  });

  it('readiness unavailable（非 macOS）→ ok:false unsupported-platform，日志带 reason', async () => {
    registerMailConnector({
      execute: async () => { throw new Error('unreachable'); },
      getCachedStatus: () => ({ connected: false, readiness: 'unavailable', capabilities: [] }),
      getStatus: async () => ({ connected: false, readiness: 'unavailable', capabilities: [] }),
    });
    expect(await call('listMailSources')).toEqual({
      success: true,
      data: { ok: false, reason: 'unsupported-platform' },
    });
    expect(h.logWarn.mock.calls.some((args) => String(args[0]).includes('unsupported-platform'))).toBe(true);
  });

  it('非 ready 且探测不过 → ok:false not-authorized（带原始 detail），日志带 reason', async () => {
    registerMailConnector({
      execute: async () => { throw new Error('authorization denied'); },
    });
    const response = await call('listMailSources');
    expect(response).toEqual({
      success: true,
      data: { ok: false, reason: 'not-authorized', detail: 'authorization denied' },
    });
    expect(h.logWarn.mock.calls.some((args) => String(args[0]).includes('not-authorized'))).toBe(true);
  });

  it('list_accounts 抛错 → ok:false read-error（带 detail），日志带 reason', async () => {
    registerMailConnector({
      getCachedStatus: () => ({ connected: true, readiness: 'ready', capabilities: [] }),
      getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: [] }),
      execute: async (action: string) => {
        if (action === 'list_accounts') throw new Error('osascript exploded');
        return { data: [] };
      },
    });
    expect(await call('listMailSources')).toEqual({
      success: true,
      data: { ok: false, reason: 'read-error', detail: 'osascript exploded' },
    });
    expect(h.logWarn.mock.calls.some((args) => String(args[0]).includes('read-error'))).toBe(true);
  });

  it('ready → 账号与各账号邮箱目录；unchecked 先补探测；形状异常项被过滤', async () => {
    const probed: string[] = [];
    registerMailConnector({
      execute: async (action: string, payload: Record<string, unknown>) => {
        if (action === 'probe_access') {
          probed.push('probe');
          return { data: { connected: true, readiness: 'ready' } };
        }
        if (action === 'list_accounts') {
          return { data: [{ name: '_icloud' }, { name: '  ' }, 'not-an-object', { noName: 1 }, { name: 'gmail' }] };
        }
        if (action === 'list_mailboxes') {
          if (payload.account === '_icloud') {
            return { data: [{ account: '_icloud', name: 'INBOX' }, { account: '_icloud', name: '归档' }, { account: 'gmail', name: '别人家的' }] };
          }
          if (payload.account === 'gmail') {
            return { data: [{ account: 'gmail', name: 'INBOX' }] };
          }
          return { data: [] };
        }
        return { data: {} };
      },
    });
    expect(await call('listMailSources')).toEqual({
      success: true,
      data: {
        ok: true,
        accounts: [{ name: '_icloud' }, { name: 'gmail' }],
        // list_mailboxes 混入其它账户的邮箱按 account 字段收窄；未请求的账户不出现。
        mailboxesByAccount: { _icloud: ['INBOX', '归档'], gmail: ['INBOX'] },
      },
    });
    // unchecked → 先补探测（重启后不逼用户去设置再点一次授权）。
    expect(probed).toEqual(['probe']);
  });

  it('单账户邮箱列举失败 → 该账户降级空数组（其余照常），失败记日志可区分', async () => {
    registerMailConnector({
      getCachedStatus: () => ({ connected: true, readiness: 'ready', capabilities: [] }),
      getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: [] }),
      execute: async (action: string, payload: Record<string, unknown>) => {
        if (action === 'list_accounts') return { data: [{ name: '_icloud' }, { name: 'gmail' }] };
        if (action === 'list_mailboxes' && payload.account === '_icloud') throw new Error('mailbox listing failed');
        if (action === 'list_mailboxes') return { data: [{ account: 'gmail', name: 'INBOX' }] };
        return { data: {} };
      },
    });
    expect(await call('listMailSources')).toEqual({
      success: true,
      data: {
        ok: true,
        accounts: [{ name: '_icloud' }, { name: 'gmail' }],
        mailboxesByAccount: { _icloud: [], gmail: ['INBOX'] },
      },
    });
    expect(h.logWarn.mock.calls.some((args) => String(args[0]).includes('listing failed for account _icloud'))).toBe(true);
  });
});
