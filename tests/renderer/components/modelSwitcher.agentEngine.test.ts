import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '../../../src/shared/contract';
import type { AgentEngineDescriptor } from '../../../src/shared/contract/agentEngine';
import { buildModelSwitcherEngineSelection, shouldShowModelSettingsPrompt } from '../../../src/renderer/components/StatusBar/ModelSwitcher';
import {
  buildEngineReliabilitySummary,
  buildProviderBillingSummary,
  buildProviderHealthSummary,
  compareProviderHealth,
  ENGINE_SHORT_LABEL,
  formatExternalModelSwitcherTooltip,
  formatEngineReliabilityContract,
  formatNativeModelSwitcherTooltip,
  getProviderEffortOptions,
  ProviderBillingBadge,
  ProviderHealthBadge,
  ProviderLogo,
  ProviderSourceBadge,
  ProviderTransportBadge,
  sortProviderGroupsByModelStrategy,
} from '../../../src/renderer/components/StatusBar/modelSwitcherHelpers';

function descriptor(overrides: Partial<AgentEngineDescriptor>): AgentEngineDescriptor {
  return {
    kind: 'native',
    label: 'Neo',
    summary: '',
    installState: 'builtin',
    runtimeState: 'ready',
    executable: true,
    capabilities: ['execute'],
    defaultPermissionProfile: 'default',
    cwdPolicy: 'workspace_only',
    riskTier: 'low',
    detectedAt: 1,
    ...overrides,
  };
}

const emptyModelSettings = {
  models: {
    default: 'xiaomi',
    providers: {},
  },
} as AppSettings;

describe('ModelSwitcher Agent Engine selection', () => {
  it('uses Neo as the native engine short label', () => {
    expect(ENGINE_SHORT_LABEL.native).toBe('Neo');
  });

  it('keeps MiMo effort as intensity and leaves thinking to the separate switch', () => {
    expect(getProviderEffortOptions('xiaomi', 'mimo-v2.5-pro').map((option) => option.label))
      .toEqual(['Low', 'Med', 'High']);
  });

  it('summarizes provider health for availability grouping', () => {
    expect(buildProviderHealthSummary({
      status: 'degraded',
      latencyP50: 1789,
      errorRate: 0.24,
    })).toMatchObject({
      state: 'degraded',
      label: '降级',
      detail: 'P50 1789ms · 错误率 24%',
    });

    expect(buildProviderHealthSummary(null)).toMatchObject({
      state: 'unknown',
      label: '未检测',
      detail: '最近健康状态未上报',
    });
  });

  it('orders provider health so unavailable providers fall behind healthy providers', () => {
    expect(compareProviderHealth(
      { status: 'healthy', latencyP50: 100, errorRate: 0 },
      { status: 'unavailable', latencyP50: 4000, errorRate: 1 },
    )).toBeLessThan(0);
    expect(compareProviderHealth(
      { status: 'degraded', latencyP50: 900, errorRate: 0.1 },
      { status: 'unknown' },
    )).toBeGreaterThan(0);
  });

  it('sorts provider groups by favorite first, then provider health', () => {
    const groups = sortProviderGroupsByModelStrategy([
      {
        provider: 'qwen',
        providerLabel: 'Qwen',
        options: [{ provider: 'qwen', model: 'qwen-plus', label: 'Qwen Plus', providerLabel: 'Qwen', features: [] }],
      },
      {
        provider: 'claude',
        providerLabel: 'Claude',
        options: [{ provider: 'claude', model: 'claude-sonnet-4-6', label: 'Claude Sonnet', providerLabel: 'Claude', features: [] }],
      },
      {
        provider: 'moonshot',
        providerLabel: 'Kimi',
        providerFavorite: true,
        options: [{ provider: 'moonshot', model: 'kimi-k2.5', label: 'Kimi K2.5', providerLabel: 'Kimi', features: [] }],
      },
      {
        provider: 'openai',
        providerLabel: 'OpenAI',
        options: [{ provider: 'openai', model: 'gpt-5.5', label: 'GPT-5.5', providerLabel: 'OpenAI', features: [] }],
      },
      {
        provider: 'zhipu',
        providerLabel: 'GLM',
        options: [{ provider: 'zhipu', model: 'glm-4.5-flash', label: 'GLM Flash', providerLabel: 'GLM', features: [] }],
      },
    ], {
      moonshot: { status: 'unavailable' },
      zhipu: { status: 'healthy' },
      openai: { status: 'recovering' },
      qwen: { status: 'unknown' },
      claude: { status: 'degraded' },
    });

    expect(groups.map((group) => group.provider)).toEqual([
      'moonshot',
      'zhipu',
      'openai',
      'qwen',
      'claude',
    ]);
  });

  it('summarizes provider billing mode for model strategy badges', () => {
    expect(buildProviderBillingSummary('payg')).toMatchObject({
      mode: 'payg',
      label: '按量',
      detail: expect.stringContaining('降低成本和延迟'),
    });
    expect(buildProviderBillingSummary('plan')).toMatchObject({
      mode: 'plan',
      label: '套餐',
      detail: expect.stringContaining('通常不省钱'),
    });
    expect(buildProviderBillingSummary()).toMatchObject({
      mode: 'unknown',
      label: '计费未知',
      detail: expect.stringContaining('保守处理'),
    });
  });

  it('renders provider billing badges with model strategy metadata', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderBillingBadge, {
      summary: buildProviderBillingSummary('unknown'),
    }));

    expect(html).toContain('data-provider-billing-mode="unknown"');
    expect(html).toContain('计费未知');
    expect(html).toContain('自动策略会保守处理');
  });

  it('renders provider health badges with availability metadata', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderHealthBadge, {
      summary: buildProviderHealthSummary({
        status: 'unavailable',
        latencyP50: 4200,
        errorRate: 0.91,
      }),
    }));

    expect(html).toContain('data-provider-health-state="unavailable"');
    expect(html).toContain('Provider 状态: 不可用');
    expect(html).toContain('P50 4200ms · 错误率 91%');
    expect(html).toContain('不可用');
  });

  it('renders provider source badges so custom icons cannot hide relay identity', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderSourceBadge, {
      sourceLabel: 'CommonStack',
    }));

    expect(html).toContain('data-provider-source-label="CommonStack"');
    expect(html).toContain('title="来源: CommonStack"');
    expect(html).toContain('来源 CommonStack');
  });

  it('does not render an empty provider source badge', () => {
    expect(renderToStaticMarkup(React.createElement(ProviderSourceBadge, {}))).toBe('');
  });

  it('renders provider transport badges with protocol and endpoint identity', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderTransportBadge, {
      protocol: 'openai',
      transportLabel: 'OpenAI-compatible',
      endpoint: 'https://commonstack.example/v1',
    }));

    expect(html).toContain('data-provider-transport-protocol="openai"');
    expect(html).toContain('data-provider-endpoint="https://commonstack.example/v1"');
    expect(html).toContain('title="协议: OpenAI-compatible · Endpoint: https://commonstack.example/v1"');
    expect(html).toContain('OpenAI-compatible');
    expect(html).toContain('commonstack.example/v1');
  });

  it('does not render an empty provider transport badge', () => {
    expect(renderToStaticMarkup(React.createElement(ProviderTransportBadge, {}))).toBe('');
  });

  it('formats native trigger tooltip with main task strategy context', () => {
    expect(formatNativeModelSwitcherTooltip({
      engineLabel: 'Neo',
      currentModel: 'mimo-v2.5-pro',
      displayProvider: 'xiaomi',
      displayModel: 'mimo-v2.5-pro',
      adaptive: true,
      overridden: false,
      billingSummary: buildProviderBillingSummary('payg'),
      healthSummary: buildProviderHealthSummary({ status: 'healthy', latencyP50: 120, errorRate: 0 }),
      effort: { label: 'High' },
      thinkingLabel: 'Think',
    })).toBe(
      '自动路由（按任务、成本和能力切换，当前主任务 mimo-v2.5-pro） · Engine: Neo · 计费: 按量 · Provider: 健康 · Effort: High · Thinking: Think',
    );
  });

  it('formats native override tooltip with original main task model', () => {
    expect(formatNativeModelSwitcherTooltip({
      engineLabel: 'Neo',
      currentModel: 'kimi-k2.5',
      displayProvider: 'zhipu',
      displayModel: 'glm-4.5v',
      adaptive: false,
      overridden: true,
      billingSummary: buildProviderBillingSummary('unknown'),
      healthSummary: buildProviderHealthSummary(null),
      effort: { label: 'Default' },
    })).toBe(
      '已覆盖: zhipu/glm-4.5v (原主任务: kimi-k2.5) · Engine: Neo · 计费: 计费未知 · Provider: 未检测 · Effort: Default',
    );
  });

  it('formats external trigger tooltip with engine model, effort, and reliability', () => {
    expect(formatExternalModelSwitcherTooltip({
      engineLabel: 'Claude',
      model: 'sonnet',
      effort: { label: 'High' },
      reliabilityLabel: '认证失败',
    })).toBe('Engine: Claude · 主任务模型: sonnet · Effort: High · 状态: 认证失败');
  });

  it('shows the model settings prompt only for native sessions after settings prove no configured models', () => {
    expect(shouldShowModelSettingsPrompt('native', null, false)).toBe(false);
    expect(shouldShowModelSettingsPrompt('native', emptyModelSettings, false)).toBe(true);
    expect(shouldShowModelSettingsPrompt('native', emptyModelSettings, true)).toBe(false);
    expect(shouldShowModelSettingsPrompt('codex_cli', emptyModelSettings, false)).toBe(false);
  });

  it('builds a session-scoped engine selection without model provider fields', () => {
    const selection = buildModelSwitcherEngineSelection(descriptor({
      kind: 'codex_cli',
      label: 'Codex CLI',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }));

    expect(selection).toEqual({
      kind: 'codex_cli',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
    expect(selection).not.toHaveProperty('provider');
    expect(selection).not.toHaveProperty('model');
  });

  it('keeps Claude Code selection on the same session metadata contract', () => {
    expect(buildModelSwitcherEngineSelection(descriptor({
      kind: 'claude_code',
      label: 'Claude Code',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }))).toEqual({
      kind: 'claude_code',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('carries the current workspace as cwd for external engines', () => {
    expect(buildModelSwitcherEngineSelection(descriptor({
      kind: 'codex_cli',
      label: 'Codex CLI',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }), '/repo/code-agent')).toEqual({
      kind: 'codex_cli',
      cwd: '/repo/code-agent',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('carries the catalog model separately from provider model overrides', () => {
    expect(buildModelSwitcherEngineSelection(descriptor({
      kind: 'claude_code',
      label: 'Claude Code',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }), '/repo/code-agent', 'sonnet')).toEqual({
      kind: 'claude_code',
      cwd: '/repo/code-agent',
      model: 'sonnet',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('explains missing external engines as reliability errors', () => {
    expect(buildEngineReliabilitySummary({
      descriptor: descriptor({
        kind: 'claude_code',
        label: 'Claude Code',
        installState: 'missing',
        executable: false,
        runtimeState: 'error',
        lastError: 'claude not found',
      }),
      needsWorkspace: false,
    })).toMatchObject({
      tone: 'error',
      label: '不可用',
      summary: 'claude not found',
    });
  });

  it('prioritizes the last session failure in external engine reliability summary', () => {
    expect(buildEngineReliabilitySummary({
      descriptor: descriptor({
        kind: 'claude_code',
        label: 'Claude Code',
        installState: 'installed',
        runtimeState: 'ready',
        executable: true,
        capabilities: ['execute', 'stream_events'],
        reliability: {
          cliStatus: 'available',
          authState: 'not_checked',
          quotaState: 'not_checked',
          streamingMode: 'stream_json',
          toolSupport: 'read_only_cli_tools',
          transcriptMode: 'clean_stream_json',
        },
      }),
      needsWorkspace: false,
      selectedModel: {
        id: 'sonnet',
        label: 'Sonnet',
        capabilities: ['code'],
      },
      sessionFailure: {
        category: 'auth',
        reason: 'auth_failed',
        message: 'Failed to authenticate. API Error: 401',
        suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
        retryable: false,
        occurredAt: 60_000,
        statusCode: 401,
        exitCode: 1,
        reliability: { authState: 'needs_login' },
      },
      now: 180_000,
    })).toMatchObject({
      tone: 'error',
      label: '认证失败',
      summary: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
      detail: 'auth_failed · 2 分钟前失败 · HTTP 401 · exit 1 · 需处理',
      capabilityLine: 'CLI 可用 · 需登录 · quota 未检测 · stream-json · 干净 transcript · 只读工具',
    });
  });

  it('surfaces not configured external engines without blocking the shared contract', () => {
    expect(buildEngineReliabilitySummary({
      descriptor: descriptor({
        kind: 'codex_cli',
        label: 'Codex CLI',
        installState: 'installed',
        runtimeState: 'not_configured',
        executable: true,
      }),
      needsWorkspace: false,
    })).toMatchObject({
      tone: 'warning',
      label: '需要配置',
    });
  });

  it('explains ready external engines when the selected model lacks code-task capability', () => {
    expect(buildEngineReliabilitySummary({
      descriptor: descriptor({
        kind: 'claude_code',
        label: 'Claude Code',
        installState: 'installed',
        runtimeState: 'ready',
        executable: true,
        capabilities: ['execute', 'stream_events'],
      }),
      needsWorkspace: false,
      selectedModel: {
        id: 'haiku',
        label: 'Haiku',
        capabilities: ['vision'],
      },
    })).toMatchObject({
      tone: 'info',
      label: '可用',
      capabilityLine: '支持流式事件 · CLI 执行能力可用 · 模型目录未标记代码任务能力',
    });
  });

  it('marks ready external engines with code-capable selected models as ready', () => {
    expect(buildEngineReliabilitySummary({
      descriptor: descriptor({
        kind: 'claude_code',
        label: 'Claude Code',
        installState: 'installed',
        runtimeState: 'ready',
        executable: true,
        capabilities: ['execute', 'stream_events'],
      }),
      needsWorkspace: false,
      selectedModel: {
        id: 'sonnet',
        label: 'Sonnet',
        capabilities: ['code', 'vision'],
      },
    })).toMatchObject({
      tone: 'ready',
      label: '可用',
      capabilityLine: '支持流式事件 · CLI 执行能力可用 · 模型目录标记适合代码任务',
    });
  });

  it('surfaces Claude Code stream-json partial transcript contract in reliability details', () => {
    const claude = descriptor({
      kind: 'claude_code',
      label: 'Claude Code',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute', 'stream_events'],
      reliability: {
        cliStatus: 'available',
        authState: 'not_checked',
        quotaState: 'not_checked',
        streamingMode: 'stream_json',
        toolSupport: 'read_only_cli_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: true,
        mcpBridge: false,
      },
    });

    expect(formatEngineReliabilityContract(claude)).toBe(
      'CLI 可用 · 登录未检测 · quota 未检测 · stream-json · partial messages · 干净 transcript · 只读工具',
    );
    expect(buildEngineReliabilitySummary({
      descriptor: claude,
      needsWorkspace: false,
      selectedModel: {
        id: 'sonnet',
        label: 'Sonnet',
        capabilities: ['code'],
      },
    })?.capabilityLine).toContain('partial messages');
  });

  it('surfaces external engine auth and quota states in reliability details', () => {
    const codex = descriptor({
      kind: 'codex_cli',
      label: 'Codex CLI',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute', 'stream_events'],
      reliability: {
        cliStatus: 'available',
        authState: 'authenticated',
        quotaState: 'exhausted',
        streamingMode: 'stream_json',
        toolSupport: 'workspace_tools',
        transcriptMode: 'clean_stream_json',
      },
    });

    expect(formatEngineReliabilityContract(codex)).toContain('已登录');
    expect(formatEngineReliabilityContract(codex)).toContain('quota 耗尽');
  });

  it('renders provider image icons as images in the model switcher badge', () => {
    const icon = 'data:image/png;base64,aGVsbG8=';
    const html = renderToStaticMarkup(React.createElement(ProviderLogo, {
      provider: 'custom',
      label: 'Relay',
      icon,
    }));

    expect(html).toContain('<img');
    expect(html).toContain(`src="${icon}"`);
  });
});
