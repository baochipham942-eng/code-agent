// ============================================================================
// providerResolution 特征测试（characterization）—— 锁住每个 provider 的
// baseURL / apiKey 解析结果，作为 P2「适配器复用 provider 类解析」重构的回归网。
//
// 这些 golden 值逐一对照各 provider 类 getBaseUrl/getApiKey 的原始实现转录而来：
//   deepseek/openai/groq/minimax/perplexity/qwen/openrouter/volcengine →
//     config.baseUrl || MODEL_API_ENDPOINTS[provider]；apiKey = config.apiKey
//   xiaomi/longcat → 额外 env 兜底；zhipu 三态；moonshot kimi-k2.5 专用端点
// 重构后 provider 类委托到本模块，本测试若变红即说明转录漂移。
// ============================================================================

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { MODEL_API_ENDPOINTS } from '../../../src/shared/constants';
import {
  resolveProviderBaseUrl,
  resolveProviderApiKey,
} from '../../../src/main/model/providers/providerResolution';

// configService 单例：adapter 模式（trustConfigKey:false）会查它，受控返回。
// getSettings：动态 custom provider 的 baseUrl 兜底来源（settings.models.providers[id].baseUrl）。
const mockGetApiKey = vi.fn<(provider: string) => string | undefined>();
const mockGetSettings = vi.fn<() => unknown>();
vi.mock('../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: mockGetApiKey, getSettings: mockGetSettings }),
}));

const cfg = (provider: string, model: string, extra: Partial<ModelConfig> = {}): ModelConfig =>
  ({ provider, model, ...extra } as ModelConfig);

// 隔离 env：每个用例前快照、用例后还原，避免 .env 里真实 key 污染断言。
const ENV_KEYS = [
  'ZHIPU_OFFICIAL_API_KEY', 'KIMI_K25_API_KEY', 'KIMI_K25_API_URL',
  'XIAOMI_API_KEY', 'LONGCAT_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_BASE_URL',
];
let envSnapshot: Record<string, string | undefined>;
beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  mockGetApiKey.mockReset();
  mockGetApiKey.mockReturnValue(undefined);
  mockGetSettings.mockReset();
  mockGetSettings.mockReturnValue({});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe('resolveProviderBaseUrl', () => {
  it('简单 OpenAI 兼容 provider 用 config.baseUrl || ENDPOINTS[provider]', () => {
    expect(resolveProviderBaseUrl(cfg('deepseek', 'deepseek-chat'))).toBe(MODEL_API_ENDPOINTS.deepseek);
    expect(resolveProviderBaseUrl(cfg('openai', 'gpt-4o'))).toBe(MODEL_API_ENDPOINTS.openai);
    expect(resolveProviderBaseUrl(cfg('groq', 'llama'))).toBe(MODEL_API_ENDPOINTS.groq);
    expect(resolveProviderBaseUrl(cfg('minimax', 'abab'))).toBe(MODEL_API_ENDPOINTS.minimax);
    expect(resolveProviderBaseUrl(cfg('perplexity', 'sonar'))).toBe(MODEL_API_ENDPOINTS.perplexity);
    expect(resolveProviderBaseUrl(cfg('qwen', 'qwen-max'))).toBe(MODEL_API_ENDPOINTS.qwen);
    expect(resolveProviderBaseUrl(cfg('openrouter', 'x'))).toBe(MODEL_API_ENDPOINTS.openrouter);
    expect(resolveProviderBaseUrl(cfg('volcengine', 'doubao'))).toBe(MODEL_API_ENDPOINTS.volcengine);
    expect(resolveProviderBaseUrl(cfg('xiaomi', 'mimo-v2.5-pro'))).toBe(MODEL_API_ENDPOINTS.xiaomi);
    expect(resolveProviderBaseUrl(cfg('longcat', 'longcat-x'))).toBe(MODEL_API_ENDPOINTS.longcat);
  });

  it('config.baseUrl 覆盖默认端点（简单 provider）', () => {
    expect(resolveProviderBaseUrl(cfg('deepseek', 'deepseek-chat', { baseUrl: 'https://relay.test/v1' })))
      .toBe('https://relay.test/v1');
  });

  it('动态 custom provider：config.baseUrl 缺失时从 settings.models.providers[id].baseUrl 兜底', () => {
    mockGetSettings.mockReturnValue({
      models: { providers: { 'custom-lc-ai-02': { baseUrl: 'https://windhub.cc/v1' } } },
    });
    // config.baseUrl 没传下来（aiSdk 子代理/重建 config 的场景）→ 从用户设置兜底
    expect(resolveProviderBaseUrl(cfg('custom-lc-ai-02', 'deepseek-v3-2-251201')))
      .toBe('https://windhub.cc/v1');
    // config.baseUrl 仍最高优先
    expect(resolveProviderBaseUrl(cfg('custom-lc-ai-02', 'deepseek-v3-2-251201', { baseUrl: 'https://other.test/v1' })))
      .toBe('https://other.test/v1');
  });

  it('动态 custom provider：settings 也没有 → 返回空串（调用方报错）', () => {
    expect(resolveProviderBaseUrl(cfg('custom-unknown-99', 'some-model'))).toBe('');
    // configService 抛异常也不致命
    mockGetSettings.mockImplementation(() => { throw new Error('not ready'); });
    expect(resolveProviderBaseUrl(cfg('custom-unknown-99', 'some-model'))).toBe('');
  });

  it('local → ENDPOINTS.ollama（provider id 与 endpoint key 不同名）', () => {
    expect(resolveProviderBaseUrl(cfg('local', 'qwen2.5-coder:7b'))).toBe(MODEL_API_ENDPOINTS.ollama);
  });

  it('zhipu 三态：free→官方 / coding→coding 端点 / 标准→0ki', () => {
    // glm-4-flash: costType free → 官方端点
    expect(resolveProviderBaseUrl(cfg('zhipu', 'glm-4-flash'))).toBe(MODEL_API_ENDPOINTS.zhipuOfficial);
    // glm-5: useCodingEndpoint → coding 端点
    expect(resolveProviderBaseUrl(cfg('zhipu', 'glm-5'))).toBe(MODEL_API_ENDPOINTS.zhipuCoding);
    // glm-4.6v: yearly 且无 coding flag → 标准 0ki 端点
    expect(resolveProviderBaseUrl(cfg('zhipu', 'glm-4.6v'))).toBe(MODEL_API_ENDPOINTS.zhipu);
  });

  it('zhipu free 仍允许 config.baseUrl 覆盖；coding 端点固定不被 config.baseUrl 覆盖', () => {
    expect(resolveProviderBaseUrl(cfg('zhipu', 'glm-4-flash', { baseUrl: 'https://z.test/v4' })))
      .toBe('https://z.test/v4');
    // coding 分支镜像 zhipuProvider：直接返回 codingBaseUrl，忽略 config.baseUrl
    expect(resolveProviderBaseUrl(cfg('zhipu', 'glm-5', { baseUrl: 'https://z.test/v4' })))
      .toBe(MODEL_API_ENDPOINTS.zhipuCoding);
  });

  it('moonshot kimi-k2.5 用专用端点（可被 KIMI_K25_API_URL 覆盖），其余用 moonshot 端点', () => {
    expect(resolveProviderBaseUrl(cfg('moonshot', 'kimi-k2.5'))).toBe(MODEL_API_ENDPOINTS.kimiK25);
    process.env.KIMI_K25_API_URL = 'https://k25.test/v1';
    expect(resolveProviderBaseUrl(cfg('moonshot', 'kimi-k2.5'))).toBe('https://k25.test/v1');
    expect(resolveProviderBaseUrl(cfg('moonshot', 'moonshot-v1-32k'))).toBe(MODEL_API_ENDPOINTS.moonshot);
  });

  it('claude/anthropic → ENDPOINTS.claude（config.baseUrl / ANTHROPIC_BASE_URL 优先）', () => {
    expect(resolveProviderBaseUrl(cfg('claude', 'claude-3-5-sonnet'))).toBe(MODEL_API_ENDPOINTS.claude);
    expect(resolveProviderBaseUrl(cfg('anthropic', 'claude-3-5-sonnet'))).toBe(MODEL_API_ENDPOINTS.claude);
    process.env.ANTHROPIC_BASE_URL = 'https://ar.test/v1';
    expect(resolveProviderBaseUrl(cfg('claude', 'claude-3-5-sonnet'))).toBe('https://ar.test/v1');
  });
});

describe('resolveProviderApiKey — provider 类模式（trustConfigKey 默认 true）', () => {
  it('简单 provider：config.apiKey 优先', () => {
    expect(resolveProviderApiKey(cfg('deepseek', 'deepseek-chat', { apiKey: 'sk-ds' }))).toBe('sk-ds');
    expect(resolveProviderApiKey(cfg('openai', 'gpt-4o', { apiKey: 'sk-oa' }))).toBe('sk-oa');
  });

  it('xiaomi / longcat：config.apiKey 缺失时回落对应 env', () => {
    process.env.XIAOMI_API_KEY = 'env-xiaomi';
    process.env.LONGCAT_API_KEY = 'env-longcat';
    expect(resolveProviderApiKey(cfg('xiaomi', 'mimo-v2.5-pro'))).toBe('env-xiaomi');
    expect(resolveProviderApiKey(cfg('longcat', 'longcat-x'))).toBe('env-longcat');
    // config.apiKey 仍优先于 env
    expect(resolveProviderApiKey(cfg('xiaomi', 'mimo-v2.5-pro', { apiKey: 'cfg-x' }))).toBe('cfg-x');
  });

  it('zhipu free：ZHIPU_OFFICIAL_API_KEY 优先于 config.apiKey；非 free 用 config.apiKey', () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-zhipu';
    expect(resolveProviderApiKey(cfg('zhipu', 'glm-4-flash', { apiKey: 'cfg-z' }))).toBe('official-zhipu');
    expect(resolveProviderApiKey(cfg('zhipu', 'glm-5', { apiKey: 'cfg-z' }))).toBe('cfg-z');
  });

  it('moonshot kimi-k2.5：KIMI_K25_API_KEY 优先于 config.apiKey', () => {
    process.env.KIMI_K25_API_KEY = 'k25-key';
    expect(resolveProviderApiKey(cfg('moonshot', 'kimi-k2.5', { apiKey: 'cfg-m' }))).toBe('k25-key');
    expect(resolveProviderApiKey(cfg('moonshot', 'moonshot-v1-32k', { apiKey: 'cfg-m' }))).toBe('cfg-m');
  });

  it('全部缺失返回空串', () => {
    expect(resolveProviderApiKey(cfg('deepseek', 'deepseek-chat'))).toBe('');
  });

  it('去掉 config/env/官方 key 首尾成对引号，避免复制 .env.bak 后 401', () => {
    process.env.XIAOMI_API_KEY = '"env-xiaomi"';
    process.env.ZHIPU_OFFICIAL_API_KEY = "'official-zhipu'";

    expect(resolveProviderApiKey(cfg('xiaomi', 'mimo-v2.5-pro'))).toBe('env-xiaomi');
    expect(resolveProviderApiKey(cfg('xiaomi', 'mimo-v2.5-pro', { apiKey: "'cfg-x'" }))).toBe('cfg-x');
    expect(resolveProviderApiKey(cfg('zhipu', 'glm-4-flash', { apiKey: 'cfg-z' }))).toBe('official-zhipu');
  });
});

describe('resolveProviderApiKey — adapter 模式（trustConfigKey:false）', () => {
  it('configService(provider) 优先于 env 与 config.apiKey（子代理继承父 key 不可信）', () => {
    mockGetApiKey.mockImplementation((p) => (p === 'deepseek' ? 'svc-ds' : undefined));
    expect(
      resolveProviderApiKey(cfg('deepseek', 'deepseek-chat', { apiKey: 'cfg-ds' }), { trustConfigKey: false }),
    ).toBe('svc-ds');
  });

  it('configService 缺失时回落 env，再回落 config.apiKey', () => {
    process.env.DEEPSEEK_API_KEY = 'env-ds';
    expect(
      resolveProviderApiKey(cfg('deepseek', 'deepseek-chat', { apiKey: 'cfg-ds' }), { trustConfigKey: false }),
    ).toBe('env-ds');
    delete process.env.DEEPSEEK_API_KEY;
    expect(
      resolveProviderApiKey(cfg('deepseek', 'deepseek-chat', { apiKey: 'cfg-ds' }), { trustConfigKey: false }),
    ).toBe('cfg-ds');
  });

  it('zhipu free：ZHIPU_OFFICIAL_API_KEY 仍最高优先', () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-zhipu';
    mockGetApiKey.mockImplementation((p) => (p === 'zhipu' ? 'svc-z' : undefined));
    expect(
      resolveProviderApiKey(cfg('zhipu', 'glm-4-flash', { apiKey: 'cfg-z' }), { trustConfigKey: false }),
    ).toBe('official-zhipu');
    // 非 free 走 configService
    expect(
      resolveProviderApiKey(cfg('zhipu', 'glm-5', { apiKey: 'cfg-z' }), { trustConfigKey: false }),
    ).toBe('svc-z');
  });
});
