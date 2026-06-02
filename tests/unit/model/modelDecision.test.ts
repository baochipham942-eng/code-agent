// ============================================================================
// resolveModelDecision — 单一路由决策入口测试（ADR-019 批 1）
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { resolveModelDecision } from '../../../src/main/model/modelDecision';
import type { ModelDecisionInput } from '../../../src/main/model/modelDecision';
import type { ModelConfig } from '../../../src/shared/contract';
import { DEFAULT_MODELS } from '../../../src/shared/constants';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('../../../src/main/services/infra/logger', () => ({
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
    expect(config.model).toBe('kimi-k2.5');
  });

  it('treats missing adaptive flag as off', () => {
    const { decision } = resolveModelDecision(makeInput({
      requestedConfig: makeConfig(),
      messages: SIMPLE_MESSAGE,
    }));

    expect(decision.reason).toBe('user-selected');
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
// 4. 决策对象完整性（UI/日志/统计的消费契约）
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
});
