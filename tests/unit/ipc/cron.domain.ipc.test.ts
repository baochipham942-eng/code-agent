import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';

// cron.ipc.ts 的 CRON domain dispatch 特征测试（RQ-183 续作·CRON 刀迁表前先钉住现状）：
// 9 个 action 的委派与参数解析、缺参统一 CRON_ERROR 文案、generateFromPrompt 的
// INVALID_INPUT / PARSE_ERROR 分支与模型调用形状、未知 action 的 UNKNOWN_ACTION 契约、
// 抛错兜底 CRON_ERROR + 日志。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  logError: vi.fn(),
  chat: vi.fn(async (..._a: unknown[]) => ({ content: '{"name":"日报"}' as string | undefined })),
  service: {
    listJobs: vi.fn((..._a: unknown[]) => ['job']),
    createJob: vi.fn(async (..._a: unknown[]) => ({ id: 'j1' })),
    updateJob: vi.fn(async (..._a: unknown[]) => ({ id: 'j1', updated: true })),
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
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
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

  it.each(['deleteJob', 'triggerJob', 'getExecutions'])('%s：缺 jobId → CRON_ERROR Invalid cron job id', async (action) => {
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
