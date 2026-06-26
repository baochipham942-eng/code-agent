// ============================================================================
// resolveModelDecision — 单一路由决策入口测试（ADR-019 批 1）
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { resolveModelDecision } from '../../../src/host/model/modelDecision';
import type { ModelDecisionInput } from '../../../src/host/model/modelDecision';
import type { ModelConfig, TaskModelStrategySettings } from '../../../src/shared/contract';
import { DEFAULT_MODELS } from '../../../src/shared/constants';
import { getProviderHealthMonitor } from '../../../src/host/model/providerHealthMonitor';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'moonshot',
    model: 'kimi-k2.5',
    temperature: 0.7,
    maxTokens: 8192,
    ...overrides,
  } as ModelConfig;
}

function makeInput(overrides: Partial<ModelDecisionInput> = {}): ModelDecisionInput {
  return {
    requestedConfig: makeConfig(),
    messages: [{ role: 'user', content: '你好' }],
    context: 'main-chat',
    ...overrides,
  };
}

const SIMPLE_MESSAGE = [{ role: 'user' as const, content: '你好' }];
const COMPLEX_MESSAGE = [{
  role: 'user' as const,
  content: '帮我重构这个项目的认证模块，需要考虑架构设计和向后兼容，涉及 auth.ts、session.ts、middleware.ts 三个文件的迁移，' +
    '```typescript\nexport function login() {}\n```\n```typescript\nexport function logout() {}\n```',
}];

const taskStrategy: TaskModelStrategySettings = {
  mode: 'auto',
  defaultProfile: 'main',
  profiles: {
    fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick, reasoningEffort: 'low', maxTokens: 4096 },
    main: { provider: 'xiaomi', model: DEFAULT_MODELS.chat, reasoningEffort: 'medium', maxTokens: 16384 },
    deep: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reasoningEffort: 'high', maxTokens: 32768 },
    vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision, reasoningEffort: 'medium', maxTokens: 4096 },
  },
  fallback: {
    enabled: true,
    preferSameProvider: true,
    allowCrossProvider: true,
  },
  rules: [
    { id: 'simple-chat-fast', label: '短问答', intent: 'simple_chat', enabled: true, profile: 'fast', reason: '短输入使用快速模型' },
    { id: 'code-main', label: '代码任务', intent: 'coding', enabled: true, profile: 'main', reason: '代码使用主模型' },
    { id: 'research-deep', label: '研究任务', intent: 'research', enabled: true, profile: 'deep', reason: '研究使用深度模型' },
    { id: 'vision-route', label: '视觉任务', intent: 'vision', enabled: true, profile: 'vision', reason: '图片使用视觉模型' },
  ],
};

// --------------------------------------------------------------------------
// 1. subagent 路径：adaptive 永远被剥离（泄漏修复）
// --------------------------------------------------------------------------

describe('resolveModelDecision — subagent 路径', () => {
  it('strips adaptive flag for subagent context even when requested config has adaptive=true', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      context: 'subagent',
      subagentRole: 'coder',
    }));

    expect(config.adaptive).toBe(false);
    expect(decision.reason).toBe('role-tier');
    expect(decision.role).toBe('coder');
  });

  it('keeps requested provider/model unchanged for subagent (tier already applied upstream)', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ provider: 'zhipu' as ModelConfig['provider'], model: 'glm-4-flash', adaptive: true }),
      context: 'subagent',
      subagentRole: 'explore',
      messages: SIMPLE_MESSAGE,
    }));

    expect(config.provider).toBe('zhipu');
    expect(config.model).toBe('glm-4-flash');
    expect(decision.resolvedProvider).toBe('zhipu');
    expect(decision.resolvedModel).toBe('glm-4-flash');
  });
});

// --------------------------------------------------------------------------
// 2. 主聊天：adaptive 关闭 → 用户指定直连
// --------------------------------------------------------------------------

describe('resolveModelDecision — 主聊天 adaptive 关闭', () => {
  it('returns user-selected decision with unchanged config when adaptive is off', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: false }),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.reason).toBe('user-selected');
    expect(decision.resolvedModel).toBe('kimi-k2.5');
    expect(decision.costPolicy).toBe('user-locked');
    expect(decision.speedPolicy).toBe('normal');
    expect(decision.strategySummary).toContain('用户选定');
    expect(config.model).toBe('kimi-k2.5');
  });

  it('treats missing adaptive flag as off', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig(),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.reason).toBe('user-selected');
  });

  it('labels the app DEFAULT model as default-model, not user-selected (chip noise fix)', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro', adaptive: false }),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.reason).toBe('default-model');
    expect(decision.strategySummary).toContain('默认模型');
  });

  it('still labels a non-default model as user-selected when adaptive is off', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ provider: 'moonshot', model: 'kimi-k2.5', adaptive: false }),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.reason).toBe('user-selected');
  });

  it('keeps default-model label for the default model on the adaptive complex-task keep path', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro', adaptive: true }),
      messages: COMPLEX_MESSAGE,
    }));

    expect(decision.reason).toBe('default-model');
  });
});

// --------------------------------------------------------------------------
// 3. 主聊天：adaptive 开 + 简单任务 + 按量付费 → 免费档路由
// --------------------------------------------------------------------------

describe('resolveModelDecision — simple 路由（计费门控）', () => {
  it('routes simple task to free model when billing mode is payg', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
      billingMode: 'payg',
    }));

    expect(decision.reason).toBe('simple-task-free');
    expect(decision.resolvedModel).toBe(DEFAULT_MODELS.quick);
    expect(decision.requestedModel).toBe('kimi-k2.5');
    expect(decision.taskClass).toBe('simple');
    expect(decision.costPolicy).toBe('save-cost');
    expect(decision.speedPolicy).toBe('fast-path');
    expect(decision.complexityScore).toEqual(expect.any(Number));
    expect(decision.strategySummary).toContain('降低成本');
    expect(config.model).toBe(DEFAULT_MODELS.quick);
    expect(config.provider).toBe('zhipu');
  });

  it('skips simple routing when billing mode is plan (省的钱 = 0)', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
      billingMode: 'plan',
    }));

    expect(decision.reason).toBe('billing-gate-skip');
    expect(decision.resolvedModel).toBe('kimi-k2.5');
    expect(decision.taskClass).toBe('simple');
    expect(decision.costPolicy).toBe('plan-no-savings');
    expect(decision.strategySummary).toContain('没有实际节省');
    expect(config.model).toBe('kimi-k2.5');
  });

  it('skips simple routing when billing mode is unknown (中转站保守处理)', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
      billingMode: 'unknown',
    }));

    expect(decision.reason).toBe('billing-gate-skip');
    expect(decision.resolvedModel).toBe('kimi-k2.5');
    expect(decision.costPolicy).toBe('unknown-conservative');
    expect(decision.strategySummary).toContain('计费方式未知');
  });

  it('defaults billing mode to payg when not provided (兼容批 2 之前的行为)', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.billingMode).toBe('payg');
    expect(decision.reason).toBe('simple-task-free');
  });

  it('does not route complex task to free model', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: COMPLEX_MESSAGE,
      billingMode: 'payg',
    }));

    expect(decision.reason).toBe('user-selected');
    expect(decision.taskClass).toBe('coding');
    expect(decision.capabilityNeeds).toContain('code');
    expect(decision.toolPolicy).toBe('runtime-checked');
    expect(decision.strategySummary).toContain('保证输出质量');
    expect(config.model).toBe('kimi-k2.5');
  });

  it('does not route to free model when requested model is already free tier', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({
        provider: 'zhipu' as ModelConfig['provider'],
        model: DEFAULT_MODELS.quick,
        adaptive: true,
      }),
      messages: SIMPLE_MESSAGE,
      billingMode: 'payg',
    }));

    // 已经是免费模型，无需切换
    expect(decision.resolvedModel).toBe(DEFAULT_MODELS.quick);
    expect(decision.reason).toBe('user-selected');
  });
});

// --------------------------------------------------------------------------
// 4. 主聊天：任务策略 settings 接管自动路由
// --------------------------------------------------------------------------

describe('resolveModelDecision — task strategy routing', () => {
  it('routes simple chat through configured fast profile', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
      billingMode: 'plan',
      taskStrategy,
    }));

    expect(decision.reason).toBe('strategy-fast');
    expect(decision.strategyProfile).toBe('fast');
    expect(decision.strategyRuleId).toBe('simple-chat-fast');
    expect(decision.strategyReason).toBe('短输入使用快速模型');
    expect(config.provider).toBe('zhipu');
    expect(config.model).toBe(DEFAULT_MODELS.quick);
  });

  it('routes complex research through configured deep profile with effort and max tokens', () => {
    const { config, decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: COMPLEX_MESSAGE,
      taskStrategy,
    }));

    expect(decision.reason).toBe('strategy-deep');
    expect(decision.strategyProfile).toBe('deep');
    expect(decision.taskComplexity?.level).toBe('complex');
    expect(config.provider).toBe('deepseek');
    expect(config.model).toBe(DEFAULT_MODELS.reasoning);
    expect(config.reasoningEffort).toBe('high');
    expect(config.maxTokens).toBe(32768);
  });

  it('turns off adaptive fallback when strategy forbids cross-provider fallback', () => {
    const { config } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
      taskStrategy: {
        ...taskStrategy,
        fallback: {
          enabled: true,
          preferSameProvider: true,
          allowCrossProvider: false,
        },
      },
    }));

    expect(config.adaptive).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 5. 计费方式判定（ADR-019 批 2：用户配置 > 类型默认值）
// --------------------------------------------------------------------------

describe('resolveProviderBillingMode — 计费方式判定', () => {
  it('returns user-configured billing mode when set', async () => {
    const { resolveProviderBillingMode } = await import('../../../src/host/model/modelDecision');
    const providers = {
      moonshot: { enabled: true, billingMode: 'plan' as const },
    };
    expect(resolveProviderBillingMode('moonshot', providers)).toBe('plan');
  });

  it('defaults to payg for regular providers without config (API Key 主流形态)', async () => {
    const { resolveProviderBillingMode } = await import('../../../src/host/model/modelDecision');
    expect(resolveProviderBillingMode('deepseek', {})).toBe('payg');
    expect(resolveProviderBillingMode('moonshot', { moonshot: { enabled: true } })).toBe('payg');
  });

  it('defaults to unknown for dynamic custom providers (中转站保守处理)', async () => {
    const { resolveProviderBillingMode } = await import('../../../src/host/model/modelDecision');
    expect(resolveProviderBillingMode('custom-commonstack', {})).toBe('unknown');
    expect(resolveProviderBillingMode('custom-my-relay-2', {})).toBe('unknown');
  });

  it('user config overrides custom provider default', async () => {
    const { resolveProviderBillingMode } = await import('../../../src/host/model/modelDecision');
    const providers = {
      'custom-commonstack': { enabled: true, billingMode: 'payg' as const },
    };
    expect(resolveProviderBillingMode('custom-commonstack', providers)).toBe('payg');
  });

  it('zhipu provider defaults to payg (免费档由模型决定，不是 provider)', async () => {
    const { resolveProviderBillingMode } = await import('../../../src/host/model/modelDecision');
    // provider 级别的计费方式和"某个模型免费"是两回事：
    // zhipu 既有免费模型（glm-4-flash）也有付费模型（glm-5）
    expect(resolveProviderBillingMode('zhipu', {})).toBe('payg');
  });
});

// --------------------------------------------------------------------------
// 5. 档位 → 实际模型解析（ADR-019 修正 1：分发版无硬编码）
// --------------------------------------------------------------------------

describe('resolveTierModelConfig — 角色档位解析', () => {
  const BUILTIN_FAST = { provider: 'zhipu', model: 'glm-4-flash' };
  const BUILTIN_BALANCED = { provider: 'zhipu', model: 'glm-5' };
  const BUILTIN_POWERFUL = { provider: 'moonshot', model: 'kimi-k2.5' };

  const userSettings = {
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-v4-flash',
    providers: {
      deepseek: { enabled: true, apiKeyConfigured: true },
      zhipu: { enabled: true, apiKeyConfigured: true },
    },
  };

  it('powerful 档 = 用户默认模型（不硬编码厂商）', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const result = resolveTierModelConfig('powerful', BUILTIN_POWERFUL, userSettings);
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-v4-flash');
  });

  it('fast 档：用户配了智谱 key → 用内置免费推荐 glm-4-flash', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const result = resolveTierModelConfig('fast', BUILTIN_FAST, userSettings);
    expect(result.provider).toBe('zhipu');
    expect(result.model).toBe('glm-4-flash');
  });

  it('fast 档：用户没配智谱 key → 降级到用户默认模型（分发版不坏）', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const noZhipu = {
      ...userSettings,
      providers: { deepseek: { enabled: true, apiKeyConfigured: true } },
    };
    const result = resolveTierModelConfig('fast', BUILTIN_FAST, noZhipu);
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-v4-flash');
  });

  it('balanced 档：用户没配智谱 key → 同样降级到用户默认模型', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const noZhipu = {
      ...userSettings,
      providers: { deepseek: { enabled: true, apiKeyConfigured: true } },
    };
    const result = resolveTierModelConfig('balanced', BUILTIN_BALANCED, noZhipu);
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-v4-flash');
  });

  it('fast 档：用户在 routing 设置里指定了 fast 模型 → 用户偏好优先于内置推荐', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const withRouting = {
      ...userSettings,
      providers: {
        deepseek: { enabled: true, apiKeyConfigured: true },
        zhipu: { enabled: true, apiKeyConfigured: true },
        groq: { enabled: true, apiKeyConfigured: true },
      },
      routingFast: { provider: 'groq', model: 'llama-3.3-70b' },
    };
    const result = resolveTierModelConfig('fast', BUILTIN_FAST, withRouting);
    expect(result.provider).toBe('groq');
    expect(result.model).toBe('llama-3.3-70b');
  });

  it('无 settings（测试/CLI 环境）→ 沿用内置默认，行为不变', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const result = resolveTierModelConfig('fast', BUILTIN_FAST, undefined);
    expect(result.provider).toBe('zhipu');
    expect(result.model).toBe('glm-4-flash');
  });

  it('禁用的 provider 视为不可用', async () => {
    const { resolveTierModelConfig } = await import('../../../src/host/model/modelDecision');
    const zhipuDisabled = {
      ...userSettings,
      providers: {
        deepseek: { enabled: true, apiKeyConfigured: true },
        zhipu: { enabled: false, apiKeyConfigured: true },
      },
    };
    const result = resolveTierModelConfig('fast', BUILTIN_FAST, zhipuDisabled);
    expect(result.provider).toBe('deepseek');
  });
});

// --------------------------------------------------------------------------
// 6. 决策对象完整性（UI/日志/统计的消费契约）
// --------------------------------------------------------------------------

describe('resolveModelDecision — 决策对象契约', () => {
  it('always carries requested and resolved fields', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true }),
      messages: SIMPLE_MESSAGE,
      billingMode: 'payg',
    }));

    expect(decision.requestedProvider).toBe('moonshot');
    expect(decision.requestedModel).toBe('kimi-k2.5');
    expect(decision.resolvedProvider).toBe('zhipu');
    expect(decision.resolvedModel).toBe(DEFAULT_MODELS.quick);
    expect(decision.fallbackFrom).toBeNull();
    expect(decision.taskClass).toBe('simple');
    expect(decision.costPolicy).toBe('save-cost');
    expect(decision.speedPolicy).toBe('fast-path');
    expect(decision.strategySummary).toBeTruthy();
    expect(decision.providerHealthSnapshot).toMatchObject({
      provider: 'zhipu',
      status: expect.any(String),
      sampledAt: expect.any(Number),
    });
  });

  it('preserves non-routing config fields (apiKey, temperature, maxTokens)', () => {
    const { config } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ adaptive: true, apiKey: 'sk-test', temperature: 0.3 }),
      messages: COMPLEX_MESSAGE,
    }));

    expect(config.apiKey).toBe('sk-test');
    expect(config.temperature).toBe(0.3);
    expect(config.maxTokens).toBe(8192);
  });

  it('captures the resolved provider health window when monitor data exists', () => {
    const provider = 'custom-health-snapshot-test' as ModelConfig['provider'];
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure(provider);
    monitor.recordFailure(provider);

    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({ provider, model: 'relay-model', adaptive: false }),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.providerHealthSnapshot).toMatchObject({
      provider,
      status: 'unavailable',
      errorRate: 1,
      consecutiveErrors: 2,
      sampledAt: expect.any(Number),
    });
    expect(decision.speedPolicy).toBe('provider-degraded');
  });

  it('carries resolved provider identity for custom relay chains', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig({
        provider: 'custom-commonstack' as ModelConfig['provider'],
        model: 'anthropic/claude-opus-4-8',
        adaptive: false,
      }),
      messages: COMPLEX_MESSAGE,
      billingMode: 'unknown',
      providerSettings: {
        'custom-commonstack': {
          enabled: true,
          billingMode: 'unknown',
          displayName: 'CommonStack',
          protocol: 'openai',
          baseUrl: 'https://commonstack.example/v1',
        },
      },
    }));

    expect(decision.providerIdentity).toEqual({
      provider: 'custom-commonstack',
      displayName: 'CommonStack',
      sourceLabel: 'CommonStack',
      protocol: 'openai',
      transportLabel: 'OpenAI-compatible',
      endpoint: 'https://commonstack.example/v1',
    });
  });
});
