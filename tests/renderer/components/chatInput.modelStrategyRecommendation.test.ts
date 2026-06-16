import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyModelStrategyRecommendationAction,
  buildModelStrategyRecommendationFeedback,
  buildModelStrategyEngineSelectionRequest,
  buildModelStrategyRecommendation,
  buildModelStrategySwitchModelRequest,
  type ModelStrategyCandidate,
} from '../../../src/renderer/components/features/chat/ChatInput/modelStrategyRecommendation';

afterEach(() => {
  vi.useRealTimers();
});

describe('buildModelStrategyRecommendation', () => {
  it('emits privacy-bounded task feedback signals for recommendation decisions', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'openai',
      currentModel: 'gpt-5',
      modelLabel: 'GPT-5',
      modelCapabilities: ['tool', 'reasoning'],
      adaptiveEnabled: false,
      billingMode: 'payg',
    });

    expect(recommendation?.taskSignal).toMatchObject({
      taskKind: 'simple',
      recommendationReason: 'simple-auto-strategy',
      requiredCapabilities: [],
      engineKind: 'native',
      currentProvider: 'openai',
      currentModel: 'gpt-5',
      billingMode: 'payg',
      modelSpeed: 'slow',
    });
    expect(recommendation?.taskSignal?.inputFingerprint).toMatch(/^len:\d+:h:[a-z0-9]+$/);

    const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'dismissed');

    expect(feedback).toMatchObject({
      outcome: 'dismissed',
      tone: 'info',
      taskKind: 'simple',
      recommendationReason: 'simple-auto-strategy',
      primaryAction: 'enable-auto',
      currentProvider: 'openai',
      currentModel: 'gpt-5',
    });
    expect(JSON.stringify(feedback)).not.toContain('解释一下 HTTP 缓存');
    expect(JSON.stringify(feedback)).not.toContain(recommendation?.key ?? 'missing-key');
  });

  it('recommends auto strategy for short native simple tasks', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
    });

    expect(recommendation).toMatchObject({
      tone: 'info',
      primaryAction: 'enable-auto',
      title: '简单任务可用自动策略',
    });
  });

  it('calls out cost and speed risk when simple payg tasks use a heavy model', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'openai',
      currentModel: 'gpt-5',
      modelLabel: 'GPT-5',
      modelCapabilities: ['tool', 'reasoning'],
      adaptiveEnabled: false,
      billingMode: 'payg',
    });

    expect(recommendation).toMatchObject({
      tone: 'info',
      primaryAction: 'enable-auto',
      title: '简单任务不必占用重模型',
    });
    expect(recommendation?.body).toContain('按量计费下可能更慢或更贵');
    expect(recommendation?.strategyFactors).toEqual([
      { label: '任务', value: '简单问答' },
      { label: '计费', value: '按量' },
      { label: '速度', value: '当前偏重' },
    ]);
    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'openai',
      currentModel: 'gpt-5',
    })).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      adaptive: true,
    });
  });

  it('does not suggest cost-saving auto routing for plan providers on standard simple tasks', () => {
    expect(buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
      billingMode: 'plan',
    })).toBeNull();
  });

  it('suggests a fast model for plan simple tasks when the current model is slow', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'openai',
      currentModel: 'gpt-5',
      modelLabel: 'GPT-5',
      modelCapabilities: ['tool', 'reasoning'],
      adaptiveEnabled: true,
      billingMode: 'plan',
      candidates: [
        {
          provider: 'zhipu',
          providerLabel: 'Zhipu',
          model: 'glm-4.5-flash',
          modelLabel: 'GLM 4.5 Flash',
          capabilities: ['tool'],
          providerHealth: { status: 'healthy' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      primaryAction: 'switch-model',
      title: '简单任务建议快模型',
      targetProvider: 'zhipu',
      targetModel: 'glm-4.5-flash',
    });
    expect(recommendation?.body).toContain('自动策略不一定会为了省钱切模型');
    expect(recommendation?.body).toContain('建议切到 Zhipu / GLM 4.5 Flash');
    expect(recommendation?.strategyFactors).toEqual([
      { label: '任务', value: '简单问答' },
      { label: '计费', value: '套餐' },
      { label: '速度', value: '当前偏重' },
      { label: '候选', value: 'Zhipu / GLM 4.5 Flash' },
      { label: '候选状态', value: '健康' },
    ]);
  });

  it('does not suggest a fast model with unknown health for plan simple tasks', () => {
    expect(buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'openai',
      currentModel: 'gpt-5',
      modelLabel: 'GPT-5',
      modelCapabilities: ['tool', 'reasoning'],
      adaptiveEnabled: true,
      billingMode: 'plan',
      candidates: [
        {
          provider: 'zhipu',
          providerLabel: 'Zhipu',
          model: 'glm-4.5-flash',
          modelLabel: 'GLM 4.5 Flash',
          capabilities: ['tool'],
          providerHealth: { status: 'unknown' },
        },
      ],
    })).toBeNull();
  });

  it('does not recommend auto again when adaptive is already enabled', () => {
    expect(buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: true,
    })).toBeNull();
  });

  it('warns when image input uses a model without vision capability', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '看一下这张截图哪里有问题',
      hasImageAttachments: true,
      engineKind: 'native',
      modelLabel: 'GLM Flash',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '图片任务建议视觉能力',
    });
  });

  it('warns and suggests auto strategy when the current native provider is degraded', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '帮我修复这个 React hook 的 bug，并改测试',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: {
        status: 'degraded',
        latencyP50: 1789,
        errorRate: 0.24,
      },
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '当前 provider 状态降级',
      primaryAction: 'enable-auto',
      primaryLabel: '采用自动',
    });
    expect(recommendation?.body).toContain('Moonshot 最近状态为降级');
    expect(recommendation?.body).toContain('P50 1789ms');
    expect(recommendation?.body).toContain('错误率 24%');
  });

  it('suggests switching to a healthy provider/model when the current provider is degraded', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '帮我修复这个 React hook 的 bug，并改测试',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: {
        status: 'degraded',
        latencyP50: 1789,
        errorRate: 0.24,
      },
      candidates: [
        {
          provider: 'moonshot',
          providerLabel: 'Moonshot',
          model: 'kimi-k2.5',
          modelLabel: 'Kimi K2.5',
          capabilities: ['tool', 'long-context'],
          providerHealth: { status: 'degraded' },
        },
        {
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt-5',
          modelLabel: 'GPT-5',
          capabilities: ['tool', 'long-context', 'vision'],
          providerHealth: { status: 'healthy' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '当前 provider 状态降级',
      primaryAction: 'switch-model',
      targetProvider: 'openai',
      targetModel: 'gpt-5',
      targetProviderLabel: 'OpenAI',
      targetModelLabel: 'GPT-5',
    });
    expect(recommendation?.body).toContain('建议切到 OpenAI / GPT-5');
    expect(recommendation?.strategyFactors).toEqual([
      { label: 'Provider', value: '降级' },
      { label: '样本', value: 'P50 1789ms，错误率 24%' },
      { label: '需要', value: '工具' },
      { label: '候选', value: 'OpenAI / GPT-5' },
      { label: '候选状态', value: '健康' },
    ]);
    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      adaptive: false,
    });
  });

  it('keeps provider-health switch recommendations aligned to required task capabilities', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '看一下这张截图哪里有问题',
      hasImageAttachments: true,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: { status: 'degraded' },
      candidates: [
        {
          provider: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'deepseek-chat',
          modelLabel: 'DeepSeek Chat',
          capabilities: ['tool'],
          providerHealth: { status: 'healthy' },
        },
        {
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt-4o',
          modelLabel: 'GPT-4o',
          capabilities: ['tool', 'vision'],
          providerHealth: { status: 'healthy' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      title: '当前 provider 状态降级',
      primaryAction: 'switch-model',
      targetProvider: 'openai',
      targetModel: 'gpt-4o',
    });
    expect(recommendation?.strategyFactors).toContainEqual({ label: '需要', value: '视觉' });
    expect(recommendation?.strategyFactors).toContainEqual({ label: '候选', value: 'OpenAI / GPT-4o' });
  });

  it('prefers a healthy fast candidate for simple tasks when the current provider is degraded', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: { status: 'degraded' },
      candidates: [
        {
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          model: 'claude-opus',
          modelLabel: 'Claude Opus',
          capabilities: ['tool', 'long-context'],
          providerHealth: { status: 'healthy' },
        },
        {
          provider: 'zhipu',
          providerLabel: 'Zhipu',
          model: 'glm-4.5-flash',
          modelLabel: 'GLM 4.5 Flash',
          capabilities: ['tool'],
          providerHealth: { status: 'healthy' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      title: '当前 provider 状态降级',
      primaryAction: 'switch-model',
      targetProvider: 'zhipu',
      targetModel: 'glm-4.5-flash',
    });
    expect(recommendation?.strategyFactors).toContainEqual({ label: '任务', value: '简单问答' });
    expect(recommendation?.strategyFactors).toContainEqual({ label: '候选', value: 'Zhipu / GLM 4.5 Flash' });
  });

  it('scopes provider-health recommendation keys by task type so dismissing one task does not hide another', () => {
    const sharedCandidates: ModelStrategyCandidate[] = [
      {
        provider: 'openai',
        providerLabel: 'OpenAI',
        model: 'gpt-4o',
        modelLabel: 'GPT-4o',
        capabilities: ['tool', 'vision'],
        providerHealth: { status: 'healthy' },
      },
    ];
    const simpleRecommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: { status: 'degraded' },
      candidates: sharedCandidates,
    });
    const visionRecommendation = buildModelStrategyRecommendation({
      inputValue: '看一下这张截图哪里有问题',
      hasImageAttachments: true,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: { status: 'degraded' },
      candidates: sharedCandidates,
    });

    expect(simpleRecommendation?.key).toContain('task:simple');
    expect(visionRecommendation?.key).toContain('task:vision');
    expect(simpleRecommendation?.key).not.toBe(visionRecommendation?.key);
  });

  it('does not switch away from a degraded provider to a provider with unknown health', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '帮我修复这个 React hook 的 bug，并改测试',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
      providerLabel: 'Moonshot',
      providerHealth: { status: 'degraded' },
      candidates: [
        {
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt-5',
          modelLabel: 'GPT-5',
          capabilities: ['tool'],
          providerHealth: { status: 'unknown' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      title: '当前 provider 状态降级',
      primaryAction: 'enable-auto',
    });
  });

  it('warns without repeating the auto action when provider is unavailable and adaptive is already enabled', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: true,
      providerLabel: 'OpenAI',
      providerHealth: {
        status: 'unavailable',
        errorRate: 1,
      },
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '当前 provider 不可用',
    });
    expect(recommendation?.primaryAction).toBeUndefined();
    expect(recommendation?.body).toContain('OpenAI 最近状态为不可用');
  });

  it('builds an adaptive switchModel request for enable-auto recommendations', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
    });

    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      adaptive: true,
    });
  });

  it('does not build a switchModel request when the recommendation has no primary action', () => {
    expect(buildModelStrategySwitchModelRequest({
      recommendation: {
        key: 'warning-only',
        tone: 'warning',
        title: '只提示',
        body: '没有可采用动作。',
      },
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toBeNull();
  });

  it('does not warn for healthy provider status by itself', () => {
    expect(buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: true,
      providerLabel: 'OpenAI',
      providerHealth: {
        status: 'healthy',
        latencyP50: 320,
        errorRate: 0,
      },
    })).toBeNull();
  });

  it('suggests a concrete vision model when image input uses a non-vision model', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '看一下这张截图哪里有问题',
      hasImageAttachments: true,
      engineKind: 'native',
      currentProvider: 'zhipu',
      currentModel: 'glm-flash',
      modelLabel: 'GLM Flash',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
      candidates: [
        {
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt-4o',
          modelLabel: 'GPT-4o',
          capabilities: ['tool', 'vision'],
          providerHealth: { status: 'healthy' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      title: '图片任务建议视觉能力',
      primaryAction: 'switch-model',
      targetProvider: 'openai',
      targetModel: 'gpt-4o',
    });
  });

  it('scopes vision recommendation keys by task input', () => {
    const firstRecommendation = buildModelStrategyRecommendation({
      inputValue: '看一下登录页截图哪里有问题',
      hasImageAttachments: true,
      engineKind: 'native',
      currentProvider: 'zhipu',
      currentModel: 'glm-flash',
      modelLabel: 'GLM Flash',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
    });
    const secondRecommendation = buildModelStrategyRecommendation({
      inputValue: '看一下设置页截图哪里有问题',
      hasImageAttachments: true,
      engineKind: 'native',
      currentProvider: 'zhipu',
      currentModel: 'glm-flash',
      modelLabel: 'GLM Flash',
      modelCapabilities: ['tool'],
      adaptiveEnabled: false,
    });

    expect(firstRecommendation?.key).toContain('看一下登录页截图哪里有问题');
    expect(secondRecommendation?.key).toContain('看一下设置页截图哪里有问题');
    expect(firstRecommendation?.key).not.toBe(secondRecommendation?.key);
  });

  it('suggests a concrete search model when web-search input uses a non-search model', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '查一下最新 release note 有什么变化',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      modelLabel: 'Kimi K2.5',
      modelCapabilities: ['tool', 'long-context'],
      adaptiveEnabled: false,
      candidates: [
        {
          provider: 'perplexity',
          providerLabel: 'Perplexity',
          model: 'sonar-pro',
          modelLabel: 'Sonar Pro',
          capabilities: ['search', 'long-context'],
          providerHealth: { status: 'healthy' },
        },
      ],
    });

    expect(recommendation).toMatchObject({
      title: '这个任务可能需要联网搜索',
      primaryAction: 'switch-model',
      targetProvider: 'perplexity',
      targetModel: 'sonar-pro',
    });
    expect(recommendation?.body).toContain('不太擅长搜索');
    expect(recommendation?.strategyFactors).toEqual([
      { label: '任务', value: '联网检索' },
      { label: '需要', value: '搜索' },
      { label: '候选', value: 'Perplexity / Sonar Pro' },
      { label: '候选状态', value: '健康' },
    ]);
    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toEqual({
      provider: 'perplexity',
      model: 'sonar-pro',
      adaptive: false,
    });
  });

  it('does not warn for web-search input when the current model is search-capable', () => {
    expect(buildModelStrategyRecommendation({
      inputValue: '查一下最新 release note 有什么变化',
      hasImageAttachments: false,
      engineKind: 'native',
      currentProvider: 'perplexity',
      currentModel: 'sonar-pro',
      modelLabel: 'Sonar Pro',
      modelCapabilities: ['search', 'long-context'],
      adaptiveEnabled: false,
    })).toBeNull();
  });

  it('warns when code or artifact tasks use a model without tool capability', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '帮我修复这个 React hook 的 bug，并改测试',
      hasImageAttachments: false,
      engineKind: 'native',
      modelLabel: 'Reasoner',
      modelCapabilities: ['reasoning'],
      adaptiveEnabled: false,
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '这轮更依赖工具能力',
    });
  });

  it('leaves external engines alone for simple text prompts', () => {
    expect(buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
    })).toBeNull();
  });

  it('warns before sending when the selected external engine has a recent failure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(180_000);
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
      externalEngineFailure: {
        category: 'auth',
        reason: 'auth_failed',
        message: 'Failed to authenticate',
        suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
        retryable: false,
        occurredAt: 60_000,
        statusCode: 401,
        reliability: { authState: 'needs_login' },
      },
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: 'Claude Code 最近运行失败',
      primaryAction: 'switch-native-engine',
      primaryLabel: '切回 Native',
    });
    expect(recommendation?.body).toContain('2 分钟前失败');
    expect(recommendation?.body).toContain('认证失败');
    expect(recommendation?.body).toContain('Claude CLI 登录');
    expect(recommendation?.strategyFactors).toEqual([
      { label: '引擎', value: 'Claude Code' },
      { label: '失败', value: '认证失败' },
      { label: '时间', value: '2 分钟前失败' },
      { label: '恢复', value: '需处理' },
    ]);
    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toBeNull();
    expect(buildModelStrategyEngineSelectionRequest(recommendation)).toEqual({
      kind: 'native',
      permissionProfile: 'default',
    });
  });

  it('applies a native-engine switch for non-retryable external engine failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(180_000);
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
      externalEngineFailure: {
        category: 'auth',
        reason: 'auth_failed',
        message: 'Failed to authenticate',
        suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
        retryable: false,
        occurredAt: 60_000,
      },
    });
    const switchModel = vi.fn();
    const updateSessionEngine = vi.fn(async () => undefined);
    const applyOverride = vi.fn();
    const dismiss = vi.fn();
    const recordFeedback = vi.fn();
    const notifySuccess = vi.fn();
    const notifyError = vi.fn();

    await expect(applyModelStrategyRecommendationAction({
      currentSessionId: 'session-1',
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      switchModel,
      updateSessionEngine,
      applyOverride,
      dismiss,
      recordFeedback,
      notifySuccess,
      notifyError,
    })).resolves.toBe('switch-native-engine');

    expect(updateSessionEngine).toHaveBeenCalledWith('session-1', {
      kind: 'native',
      permissionProfile: 'default',
    });
    expect(applyOverride).toHaveBeenCalledWith(null);
    expect(dismiss).toHaveBeenCalledWith(recommendation?.key);
    expect(recordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'applied',
      taskKind: 'external-failure',
      primaryAction: 'switch-native-engine',
    }));
    expect(notifySuccess).toHaveBeenCalledWith('已切回 Native 主任务模型');
    expect(notifyError).not.toHaveBeenCalled();
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('applies a concrete switch-model recommendation against the current session', async () => {
    const recommendation = {
      key: 'switch-model:zhipu/glm-4.5v',
      tone: 'warning' as const,
      title: '当前模型缺少视觉能力',
      body: '建议切到视觉模型处理本轮任务。',
      primaryAction: 'switch-model' as const,
      primaryLabel: '采用建议',
      targetProvider: 'zhipu' as const,
      targetModel: 'glm-4.5v',
      targetProviderLabel: '智谱 GLM',
      targetModelLabel: 'GLM-4.5V',
    };
    const switchModel = vi.fn(async () => ({ success: true }));
    const updateSessionEngine = vi.fn(async () => undefined);
    const applyOverride = vi.fn();
    const dismiss = vi.fn();
    const recordFeedback = vi.fn();
    const notifySuccess = vi.fn();
    const notifyError = vi.fn();

    await expect(applyModelStrategyRecommendationAction({
      currentSessionId: 'session-vision',
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      switchModel,
      updateSessionEngine,
      applyOverride,
      dismiss,
      recordFeedback,
      notifySuccess,
      notifyError,
    })).resolves.toBe('switch-model');

    expect(switchModel).toHaveBeenCalledWith({
      sessionId: 'session-vision',
      provider: 'zhipu',
      model: 'glm-4.5v',
      adaptive: false,
    });
    expect(applyOverride).toHaveBeenCalledWith({
      provider: 'zhipu',
      model: 'glm-4.5v',
      adaptive: false,
    });
    expect(dismiss).toHaveBeenCalledWith('switch-model:zhipu/glm-4.5v');
    expect(recordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'applied',
      primaryAction: 'switch-model',
      targetProvider: 'zhipu',
      targetModel: 'glm-4.5v',
    }));
    expect(notifySuccess).toHaveBeenCalledWith('已切换到 智谱 GLM / GLM-4.5V');
    expect(updateSessionEngine).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('applies enable-auto recommendations without changing the main task model identity', async () => {
    const recommendation = {
      key: 'enable-auto:simple-task',
      tone: 'info' as const,
      title: '简单任务可以使用自动策略',
      body: '按量计费下自动策略会为简单任务选择更快模型。',
      primaryAction: 'enable-auto' as const,
      primaryLabel: '采用自动',
    };
    const switchModel = vi.fn(async () => ({ success: true }));
    const updateSessionEngine = vi.fn(async () => undefined);
    const applyOverride = vi.fn();
    const dismiss = vi.fn();
    const recordFeedback = vi.fn();
    const notifySuccess = vi.fn();
    const notifyError = vi.fn();

    await expect(applyModelStrategyRecommendationAction({
      currentSessionId: 'session-simple',
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
      switchModel,
      updateSessionEngine,
      applyOverride,
      dismiss,
      recordFeedback,
      notifySuccess,
      notifyError,
    })).resolves.toBe('enable-auto');

    expect(switchModel).toHaveBeenCalledWith({
      sessionId: 'session-simple',
      provider: 'moonshot',
      model: 'kimi-k2.5',
      adaptive: true,
    });
    expect(applyOverride).toHaveBeenCalledWith({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      adaptive: true,
    });
    expect(dismiss).toHaveBeenCalledWith('enable-auto:simple-task');
    expect(recordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'applied',
      primaryAction: 'enable-auto',
    }));
    expect(notifySuccess).toHaveBeenCalledWith('已采用自动模型策略');
    expect(updateSessionEngine).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('does not offer a native-engine switch for retryable external engine failures', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '解释一下 HTTP 缓存',
      hasImageAttachments: false,
      engineKind: 'codex_cli',
      modelLabel: 'GPT-5',
      modelCapabilities: [],
      adaptiveEnabled: false,
      externalEngineFailure: {
        category: 'timeout',
        reason: 'timeout',
        message: 'timed out',
        suggestion: '外部 engine 超时。可以稍后重试，或切回 Native 主任务模型完成本轮任务。',
        retryable: true,
      },
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: 'Codex CLI 最近运行失败',
    });
    expect(recommendation?.primaryAction).toBeUndefined();
    expect(recommendation?.strategyFactors).toContainEqual({ label: '恢复', value: '可重试' });
    expect(buildModelStrategyEngineSelectionRequest(recommendation)).toBeNull();
  });

  it('warns when external engines receive image attachments', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '看一下这张截图',
      hasImageAttachments: true,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '外部引擎暂不接收附件',
      primaryAction: 'switch-native-engine',
      primaryLabel: '切回 Native',
    });
    expect(recommendation?.body).toContain('只接收文本 prompt');
    expect(recommendation?.body).toContain('Native 主任务模型');
    expect(recommendation?.strategyFactors).toEqual([
      { label: '引擎', value: 'Claude Code' },
      { label: '输入', value: '图片附件' },
      { label: '链路', value: '文本 prompt' },
    ]);
    expect(buildModelStrategyEngineSelectionRequest(recommendation)).toEqual({
      kind: 'native',
      permissionProfile: 'default',
    });
    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toBeNull();
  });

  it('scopes external attachment recommendation keys by task input', () => {
    const firstRecommendation = buildModelStrategyRecommendation({
      inputValue: '看一下登录页截图',
      hasImageAttachments: true,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
    });
    const secondRecommendation = buildModelStrategyRecommendation({
      inputValue: '看一下设置页截图',
      hasImageAttachments: true,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
    });

    expect(firstRecommendation?.key).toContain('看一下登录页截图');
    expect(secondRecommendation?.key).toContain('看一下设置页截图');
    expect(firstRecommendation?.key).not.toBe(secondRecommendation?.key);
  });

  it('warns when external engines are used for write-heavy code or artifact tasks', () => {
    const recommendation = buildModelStrategyRecommendation({
      inputValue: '帮我实现这个组件并改测试',
      hasImageAttachments: false,
      engineKind: 'codex_cli',
      modelLabel: 'GPT-5',
      modelCapabilities: [],
      adaptiveEnabled: false,
    });

    expect(recommendation).toMatchObject({
      tone: 'warning',
      title: '外部引擎当前是只读链路',
      primaryAction: 'switch-native-engine',
      primaryLabel: '切回 Native',
    });
    expect(recommendation?.body).toContain('只读 CLI 链路');
    expect(buildModelStrategyEngineSelectionRequest(recommendation)).toEqual({
      kind: 'native',
      permissionProfile: 'default',
    });
    expect(buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    })).toBeNull();
  });
});
