// ============================================================================
// QuickModel 策略解析 + thinking 关闭 + 节流 Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MODELS, QUICK_MODEL_AUTH_BLACKLIST_MS } from '../../../src/shared/constants';

const { getConfigServiceMock, loggerErrorMock, loggerInfoMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: loggerInfoMock, warn: vi.fn(), error: loggerErrorMock, debug: vi.fn() }),
}));

import {
  getQuickModelAuthFailure,
  getQuickModelFailure,
  getQuickModelInfo,
  memoryTask,
  quickTask,
  resetQuickModel,
} from '../../../src/host/model/quickModel';
import { runWithMemoryModelOverride } from '../../../src/host/model/memoryModelOverrideScope';

/** 构造一个 configService mock，可指定哪些 provider 有 key */
function mockConfig(opts: {
  memory?: { provider: string; model: string };
  fast?: { provider: string; model: string };
  code?: { provider: string; model: string };
  keys?: Record<string, string>;
  providers?: Record<string, { enabled: boolean; baseUrl?: string }>;
  zhipuOfficialKey?: string;
}) {
  const keys = opts.keys ?? {};
  getConfigServiceMock.mockReturnValue({
    getSettings: () => ({
      models: {
        providers: opts.providers ?? {},
        routing: {
          ...(opts.memory ? { memory: opts.memory } : {}),
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
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetQuickModel();
  getConfigServiceMock.mockReset();
  loggerErrorMock.mockReset();
  loggerInfoMock.mockReset();
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

describe('memory model 专档与回落', () => {
  it('run-scoped override 优先于全局 routing.memory 且不污染 scope 外调用', async () => {
    mockConfig({
      memory: { provider: 'zhipu', model: 'global-memory' },
      keys: { zhipu: 'global-key' },
      providers: { zhipu: { enabled: true, baseUrl: 'https://global.example/v1' } },
    });
    const fetchMock = mockFetchOnce('organized');

    const scoped = await runWithMemoryModelOverride({
      provider: 'openai',
      model: 'arm-memory',
      apiKey: 'arm-key',
      baseUrl: 'https://arm.example/v1',
    }, () => memoryTask('整理'));

    expect(scoped).toMatchObject({ success: true, provider: 'openai', model: 'arm-memory' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://arm.example/v1/chat/completions');

    const global = await memoryTask('整理');
    expect(global).toMatchObject({ success: true, provider: 'zhipu', model: 'global-memory' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://global.example/v1/chat/completions');
  });

  it('动态 custom provider 使用设置中的 baseUrl，不静默回落 fast', async () => {
    mockConfig({
      memory: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash-0731' },
      keys: { 'custom-tokenrhythm': 'tokenrhythm-key', zhipu: 'zk' },
      providers: {
        'custom-tokenrhythm': { enabled: true, baseUrl: 'https://tokenrhythm.example/v1/' },
      },
    });
    const fetchMock = mockFetchOnce('organized');

    await expect(memoryTask('整理')).resolves.toMatchObject({
      success: true,
      provider: 'custom-tokenrhythm',
      model: 'deepseek-v4-flash-0731',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://tokenrhythm.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('zhipu 下的非免费 0ki 模型尊重配置 baseUrl，免费 quick 模型仍走官方端点', async () => {
    mockConfig({
      memory: { provider: 'zhipu', model: 'DeepSeek-V4-Flash-0731' },
      keys: { zhipu: '0ki-key' },
      providers: {
        zhipu: { enabled: true, baseUrl: 'https://api.0ki.example/api/paas/v4/' },
      },
    });
    const fetchMock = mockFetchOnce('organized');

    await expect(memoryTask('整理')).resolves.toMatchObject({
      success: true,
      provider: 'zhipu',
      model: 'DeepSeek-V4-Flash-0731',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.0ki.example/api/paas/v4/chat/completions');

    mockConfig({
      keys: { zhipu: 'official-fallback-key' },
      providers: {
        zhipu: { enabled: true, baseUrl: 'https://api.0ki.example/api/paas/v4/' },
      },
    });
    await quickTask('分类');
    expect(fetchMock.mock.calls[1][0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });

  it('默认未配 routing.memory 时，同 prompt 与 quickTask 走同模型、同请求体', async () => {
    mockConfig({ keys: { zhipu: 'zk', xiaomi: 'xk' } });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'same' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const quick = await quickTask('整理这段记忆', 321);
    const memory = await memoryTask('整理这段记忆', 321);

    expect(quick).toMatchObject({ success: true, provider: 'zhipu', model: DEFAULT_MODELS.quick });
    expect(memory).toMatchObject({ success: true, provider: 'zhipu', model: DEFAULT_MODELS.quick });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(JSON.parse(fetchMock.mock.calls[0][1].body));
  });

  it('配置 routing.memory 升档后使用指定模型，日志带出生效 provider/model', async () => {
    mockConfig({
      memory: { provider: 'openai', model: 'gpt-5.4-mini' },
      keys: { openai: 'ok', zhipu: 'zk', xiaomi: 'xk' },
    });
    const fetchMock = mockFetchOnce('organized');

    const result = await memoryTask('整理');

    expect(result).toMatchObject({ success: true, provider: 'openai', model: 'gpt-5.4-mini' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('gpt-5.4-mini');
    expect(loggerInfoMock).toHaveBeenCalledWith('Memory model resolved', {
      provider: 'openai',
      model: 'gpt-5.4-mini',
      routeSource: 'memory',
      disableThinking: false,
    });
  });

  it('routing.memory 无 key 时先回落 routing.fast，fast 也无 key 时继续回落 routing.code', async () => {
    mockConfig({
      memory: { provider: 'openai', model: 'gpt-5.4-mini' },
      keys: { zhipu: 'zk', xiaomi: 'xk' },
    });
    let fetchMock = mockFetchOnce('fast fallback');
    await expect(memoryTask('整理')).resolves.toMatchObject({
      success: true,
      provider: 'zhipu',
      model: DEFAULT_MODELS.quick,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(DEFAULT_MODELS.quick);

    mockConfig({
      memory: { provider: 'openai', model: 'gpt-5.4-mini' },
      keys: { xiaomi: 'xk' },
    });
    fetchMock = mockFetchOnce('code fallback');
    await expect(memoryTask('整理')).resolves.toMatchObject({
      success: true,
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('mimo-v2.5-pro');
  });

  it('明确关闭的 routing.memory provider 不参与路由，直接使用 routing.fast', async () => {
    mockConfig({
      memory: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      keys: { deepseek: 'invalid-key', zhipu: 'zk' },
      providers: {
        deepseek: { enabled: false },
        zhipu: { enabled: true },
      },
    });
    const fetchMock = mockFetchOnce('fast fallback');

    await expect(memoryTask('整理')).resolves.toMatchObject({
      success: true,
      provider: 'zhipu',
      model: DEFAULT_MODELS.quick,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(DEFAULT_MODELS.quick);
  });

  it('明确关闭 zhipu 时环境变量兜底也不能重新启用它', async () => {
    mockConfig({
      fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      code: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      providers: { zhipu: { enabled: false } },
      keys: {},
    });
    const previous = process.env.ZHIPU_OFFICIAL_API_KEY;
    process.env.ZHIPU_OFFICIAL_API_KEY = 'disabled-provider-key';
    try {
      await expect(memoryTask('整理')).resolves.toMatchObject({
        success: false,
        failureReason: 'not_configured',
      });
    } finally {
      if (previous === undefined) delete process.env.ZHIPU_OFFICIAL_API_KEY;
      else process.env.ZHIPU_OFFICIAL_API_KEY = previous;
    }
  });

  it('memory / fast / code 都无 key 时保留现有智谱环境变量兜底', async () => {
    mockConfig({
      memory: { provider: 'openai', model: 'gpt-5.4-mini' },
      keys: {},
    });
    const previous = process.env.ZHIPU_OFFICIAL_API_KEY;
    process.env.ZHIPU_OFFICIAL_API_KEY = 'env-zhipu-key';
    const fetchMock = mockFetchOnce('env fallback');
    try {
      await expect(memoryTask('整理')).resolves.toMatchObject({
        success: true,
        provider: 'zhipu',
        model: DEFAULT_MODELS.quick,
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(DEFAULT_MODELS.quick);
    } finally {
      if (previous === undefined) delete process.env.ZHIPU_OFFICIAL_API_KEY;
      else process.env.ZHIPU_OFFICIAL_API_KEY = previous;
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

  it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])(
    '%s 用作记忆模型时关闭 thinking，正文不会被 reasoning_content 挤空',
    async (model) => {
      mockConfig({
        memory: { provider: 'deepseek', model },
        keys: { deepseek: 'dk' },
        providers: { deepseek: { enabled: true } },
      });
      const fetchMock = mockFetchOnce('organized');

      await expect(memoryTask('整理')).resolves.toMatchObject({
        success: true,
        content: 'organized',
        provider: 'deepseek',
        model,
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'disabled' });
    },
  );

  it('passes the caller abort signal through to fetch', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    const fetchMock = mockFetchOnce('ok');
    const controller = new AbortController();

    await quickTask('hi', 32, controller.signal);

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('JSON / SSE 响应兼容', () => {
  it('JSON 响应保持原有 content 解析行为', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'json-result' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(quickTask('分类')).resolves.toMatchObject({
      success: true,
      content: 'json-result',
      attempts: 1,
    });
  });

  it('SSE 响应拼接 delta content，不再把 data: 事件流交给 JSON.parse', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    const sse = [
      'data: {"choices":[{"delta":{"content":"SSE_"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"RESULT"}}]}',
      '',
      'data: {"choices":[{"message":{"content":"SSE_RESULT"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    await expect(memoryTask('整理')).resolves.toMatchObject({
      success: true,
      content: 'SSE_RESULT',
      attempts: 1,
    });
  });

  it('响应头误报 JSON 但 body 为 SSE 时仍按 SSE 解析', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    const sse = 'data: {"choices":[{"message":{"content":"body-sniffed"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(quickTask('分类')).resolves.toMatchObject({
      success: true,
      content: 'body-sniffed',
    });
  });

  it('无法解析的 200 响应留下结构化失败供 Doctor 读取，后续成功会清除', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not json or sse', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'recovered' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(quickTask('分类')).resolves.toMatchObject({
      success: false,
      failureReason: 'invalid_response',
      status: 200,
    });
    expect(getQuickModelFailure()).toMatchObject({
      provider: 'zhipu',
      failureReason: 'invalid_response',
      status: 200,
    });

    await expect(quickTask('分类')).resolves.toMatchObject({ success: true, content: 'recovered' });
    expect(getQuickModelFailure()).toBeNull();
  });
});

describe('瞬态故障分型与候选恢复', () => {
  it('429/code1305 触发 limiter 后沿 routing.fast → routing.code 恢复', async () => {
    mockConfig({ keys: { zhipu: 'zk', xiaomi: 'xk' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => '{"code":1305,"message":"该模型当前访问量过大"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ choices: [{ message: { content: 'SAY_GAP' } }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await quickTask('分类');

    expect(result).toMatchObject({ success: true, content: 'SAY_GAP', provider: 'xiaomi', attempts: 2 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(DEFAULT_MODELS.quick);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('mimo-v2.5-pro');
  });

  it.each([
    [429, 'rate_limited', '{"code":1305,"message":"访问量过大"}'],
    [503, 'server_error', 'temporarily unavailable'],
  ] as const)('单候选 HTTP %s 重试一次后保留结构化原因 %s', async (status, failureReason, body) => {
    mockConfig({ keys: { zhipu: 'zk' }, code: { provider: 'zhipu', model: DEFAULT_MODELS.quick } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => body,
    }));

    const result = await quickTask('分类');

    expect(result).toMatchObject({ success: false, status, failureReason, attempts: 2 });
  });

  it('HTTP 200 但空 content 单独标记 empty_response，不伪装成网络错误', async () => {
    mockConfig({ keys: { zhipu: 'zk' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }),
    }));

    await expect(quickTask('分类')).resolves.toMatchObject({
      success: false,
      failureReason: 'empty_response',
      attempts: 1,
    });
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
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ choices: [{ message: { content: 'general' } }] }),
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
