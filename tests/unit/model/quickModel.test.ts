// ============================================================================
// QuickModel 策略解析 + thinking 关闭 + 节流 Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MODELS, QUICK_MODEL_AUTH_BLACKLIST_MS } from '../../../src/shared/constants';

const { getConfigServiceMock, loggerErrorMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: loggerErrorMock, debug: vi.fn() }),
}));

import {
  getQuickModelAuthFailure,
  getQuickModelInfo,
  quickTask,
  resetQuickModel,
} from '../../../src/host/model/quickModel';

/** 构造一个 configService mock，可指定哪些 provider 有 key */
function mockConfig(opts: {
  fast?: { provider: string; model: string };
  code?: { provider: string; model: string };
  keys?: Record<string, string>;
  zhipuOfficialKey?: string;
}) {
  const keys = opts.keys ?? {};
  getConfigServiceMock.mockReturnValue({
    getSettings: () => ({
      models: {
        routing: {
          fast: opts.fast ?? { provider: 'zhipu', model: DEFAULT_MODELS.quick },
          code: opts.code ?? { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
        },
      },
    }),
    getApiKey: (p: string) => keys[p],
    getZhipuOfficialKey: () => opts.zhipuOfficialKey ?? keys.zhipu,
  });
}

function mockFetchOnce(content: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetQuickModel();
  getConfigServiceMock.mockReset();
  loggerErrorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('quick model 策略解析', () => {
  it('1) 有专用快模型 key → 用 routing.fast（智谱），不关 thinking', () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    expect(getQuickModelInfo()).toEqual({ provider: 'zhipu', model: DEFAULT_MODELS.quick });
  });

  it('2) 无专用快模型 key、有主模型 key → 回落 routing.code（mimo）', () => {
    mockConfig({ keys: { xiaomi: 'xk' } }); // 没有 zhipu key
    expect(getQuickModelInfo()).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });
  });

  it('3) 两者都没 key → quick model 不可用', () => {
    mockConfig({ keys: {} });
    // 没有 ZHIPU_OFFICIAL/ZHIPU env 的前提下应为 null
    const prevA = process.env.ZHIPU_OFFICIAL_API_KEY; const prevB = process.env.ZHIPU_API_KEY;
    delete process.env.ZHIPU_OFFICIAL_API_KEY; delete process.env.ZHIPU_API_KEY;
    try {
      expect(getQuickModelInfo()).toBeNull();
    } finally {
      if (prevA !== undefined) process.env.ZHIPU_OFFICIAL_API_KEY = prevA;
      if (prevB !== undefined) process.env.ZHIPU_API_KEY = prevB;
    }
  });
});

describe('thinking 模型回落时自动关闭思考', () => {
  it('回落到 mimo 时请求体注入 thinking:{type:disabled}', async () => {
    mockConfig({ keys: { xiaomi: 'xk' } });
    const fetchMock = mockFetchOnce('general');

    const res = await quickTask('分类这句话', 10);
    expect(res.success).toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.model).toBe('mimo-v2.5-pro');
  });

  it('走智谱 glm-flash 时不注入 thinking（非 reasoning 模型）', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    const fetchMock = mockFetchOnce('ok');

    await quickTask('hi');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });
});

describe('快模型鉴权失败诊断 + 401 拉黑降级', () => {
  it('401 留下鉴权失败记录且不泄露 API Key；下一次调用自动降级到主模型并清除记录', async () => {
    const apiKey = 'quick-model-secret-canary';
    mockConfig({ keys: { zhipu: apiKey, xiaomi: 'xk' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => `expired credential ${apiKey}`,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'general' } }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const failed = await quickTask('分类这句话');

    expect(failed).toMatchObject({
      success: false,
      authFailed: true,
    });
    expect(failed.error).not.toContain(apiKey);
    expect(getQuickModelAuthFailure()).toMatchObject({
      provider: 'zhipu',
      model: DEFAULT_MODELS.quick,
      status: 401,
    });
    expect(getQuickModelAuthFailure()?.at).toEqual(expect.any(Number));
    expect(loggerErrorMock).toHaveBeenCalledWith(
      '快模型鉴权失败，疑似 API Key 无效或已过期',
      {
        provider: 'zhipu',
        model: DEFAULT_MODELS.quick,
        status: 401,
      },
    );
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(apiKey);

    // 拉黑生效：第二次调用不再撞失效的 zhipu，降级到 routing.code（mimo）
    const succeeded = await quickTask('再试一次');
    expect(succeeded.success).toBe(true);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.model).toBe('mimo-v2.5-pro');
    expect(getQuickModelAuthFailure()).toBeNull();
  });

  it('失效 key 不比没 key 糟：401 后解析降到 code 档；resetQuickModel 清黑名单后回到 fast', async () => {
    mockConfig({ keys: { zhipu: 'dead-key', xiaomi: 'xk' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid',
    }));

    await quickTask('hi');
    expect(getQuickModelInfo()).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });

    resetQuickModel();
    expect(getQuickModelInfo()).toEqual({ provider: 'zhipu', model: DEFAULT_MODELS.quick });
  });

  it('换了 key（指纹不同）立即恢复重试 fast 档，不用等窗口', async () => {
    mockConfig({ keys: { zhipu: 'dead-key', xiaomi: 'xk' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid',
    }));
    await quickTask('hi');
    expect(getQuickModelInfo()).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });

    mockConfig({ keys: { zhipu: 'fresh-new-key', xiaomi: 'xk' } });
    expect(getQuickModelInfo()).toEqual({ provider: 'zhipu', model: DEFAULT_MODELS.quick });
  });

  it('拉黑窗口过期后重试 fast 档', async () => {
    mockConfig({ keys: { zhipu: 'dead-key', xiaomi: 'xk' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid',
    }));
    await quickTask('hi');
    expect(getQuickModelInfo()).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });

    // 只挪 Date.now（拉黑窗口的唯一判据），不动 timer 体系——限流器依赖真实定时器
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + QUICK_MODEL_AUTH_BLACKLIST_MS + 1);
    try {
      expect(getQuickModelInfo()).toEqual({ provider: 'zhipu', model: DEFAULT_MODELS.quick });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
