import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelConfig, ModelProviderSettings } from '../../../src/shared/contract';
import type { ProviderInfo } from '../../../src/shared/constants';
import { PROVIDER_ICON_ASSET_URI_PREFIX } from '../../../src/shared/modelRuntime';
import {
  buildDefaultModelSettingsUpdate,
  buildManualModelSettings,
  buildLegacyLongCatProviderMigration,
  buildProviderConfigForSave,
  buildProviderManagementRows,
  buildProviderSettingsUpdate,
  createCustomProviderId,
  describeProviderIconValidationError,
  describeKeylessReadiness,
  shouldPromoteProviderToDefault,
  getModelLabel,
  hasCustomEndpointOverride,
  isModelMetadataLocked,
  isProviderIdentityManaged,
  isLegacyLongCatProviderConfig,
  normalizeLongCatModelId,
  orderProviderManagementRows,
  providerRequiresApiKey,
  resolveModelForProvider,
} from '../../../src/renderer/components/features/settings/tabs/ModelSettings.helpers';

const openaiProvider = {
  id: 'openai',
  name: 'OpenAI',
  description: 'OpenAI API',
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', evalEligible: false },
  ],
} satisfies ProviderInfo;

const moonshotProvider = {
  id: 'moonshot',
  name: 'Kimi',
  description: 'Moonshot API',
  models: [
    { id: 'kimi-k2.5', label: 'Kimi K2.5' },
    { id: 'kimi-k2.6', label: 'Kimi K2.6' },
  ],
} satisfies ProviderInfo;

const config = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  apiKey: 'sk-test',
  temperature: 0.7,
} satisfies ModelConfig;
const tinyPngIcon = 'data:image/png;base64,aGVsbG8=';
const localIconAsset = `${PROVIDER_ICON_ASSET_URI_PREFIX}relay-abcd1234.png`;

describe('ModelSettings management helpers', () => {
  it('resolves provider default model when switching providers', () => {
    expect(resolveModelForProvider(openaiProvider, 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(resolveModelForProvider(openaiProvider, 'kimi-k2.5')).toBe('gpt-5.5');
    expect(resolveModelForProvider(moonshotProvider, 'gpt-5.5')).toBe('kimi-k2.5');
  });

  it('builds provider management rows from the catalog and current config', () => {
    const providerConfigs: Partial<Record<ModelConfig['provider'], ModelProviderSettings>> = {
      openai: {
        enabled: true,
        models: {
          'gpt-5.5': { enabled: true },
          'gpt-5.4-mini': { enabled: false },
        },
      },
    };
    const rows = buildProviderManagementRows({
      providers: [openaiProvider, moonshotProvider],
      config,
      providerConfigs,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'openai',
      selected: true,
      modelCount: 2,
      enabledModelCount: 1,
      evalEligibleCount: 1,
      defaultModel: 'gpt-5.5',
      selectedModelLabel: 'GPT-5.4 Mini',
    });
    expect(rows[1]).toMatchObject({
      id: 'moonshot',
      selected: false,
      selectedModelLabel: 'Kimi K2.5',
    });
  });

  it('prefers configured provider model for provider management default display', () => {
    const providerConfigs: Partial<Record<ModelConfig['provider'], ModelProviderSettings>> = {
      openai: {
        enabled: false,
        model: 'gpt-5.4-mini',
      },
    };

    const [row] = buildProviderManagementRows({
      providers: [openaiProvider],
      config: { ...config, provider: 'moonshot', model: 'kimi-k2.5' },
      providerConfigs,
    });

    expect(row.defaultModel).toBe('gpt-5.4-mini');
    expect(row.selectedModelLabel).toBe('GPT-5.4 Mini');
  });

  it('pins the default provider to the top of the management list', () => {
    const rows = buildProviderManagementRows({
      providers: [moonshotProvider, openaiProvider],
      config,
      providerConfigs: {},
    });

    expect(orderProviderManagementRows(rows, 'openai').map((row) => row.id)).toEqual(['openai', 'moonshot']);
  });

  it('keeps a stable order regardless of selection (no reorder on click)', () => {
    const rows = buildProviderManagementRows({
      providers: [moonshotProvider, openaiProvider],
      config,
      providerConfigs: {},
    });

    // 不传默认 → 保持输入顺序；选中项不再被提到最前。
    expect(orderProviderManagementRows(rows).map((row) => row.id)).toEqual(['moonshot', 'openai']);
    // 传默认 moonshot → 仅默认置顶，其余稳定。
    expect(orderProviderManagementRows(rows, 'moonshot').map((row) => row.id)).toEqual(['moonshot', 'openai']);
  });

  it('falls back to raw model id when a label is unavailable', () => {
    expect(getModelLabel(openaiProvider.models, 'gpt-5.5')).toBe('GPT-5.5');
    expect(getModelLabel(openaiProvider.models, 'unknown-model')).toBe('unknown-model');
  });

  it('prefers enabled discovered models for custom providers', () => {
    const customProvider = {
      id: 'custom',
      name: 'Custom Provider',
      description: 'OpenAI compatible',
      models: [{ id: 'custom-model', label: 'Custom Model' }],
    } satisfies ProviderInfo;
    const customConfig = {
      provider: 'custom',
      model: 'mimo-v2.5-pro',
      apiKey: 'sk-test',
    } satisfies ModelConfig;
    const providerConfigs: Partial<Record<ModelConfig['provider'], ModelProviderSettings>> = {
      custom: {
        enabled: true,
        displayName: 'mimo',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        models: {
          'custom-model': { enabled: false },
          'mimo-v2.5-pro': {
            enabled: true,
            label: 'mimo-v2.5-pro',
            capabilities: ['general', 'reasoning', 'longContext'],
          },
        },
      },
    };

    expect(resolveModelForProvider(customProvider, 'missing-model', providerConfigs.custom)).toBe('mimo-v2.5-pro');

    const [row] = buildProviderManagementRows({
      providers: [customProvider],
      config: customConfig,
      providerConfigs,
    });
    expect(row).toMatchObject({
      id: 'custom',
      name: 'mimo',
      modelCount: 2,
      enabledModelCount: 1,
      endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1',
      selectedModelLabel: 'mimo-v2.5-pro',
    });
  });

  it('builds enabled manual model settings from a raw model id', () => {
    expect(buildManualModelSettings(' glm-5-thinking-vision ', '', 12345)).toMatchObject({
      label: 'glm-5-thinking-vision',
      enabled: true,
      capabilities: expect.arrayContaining(['general', 'reasoning', 'vision']),
      supportsTool: true,
      supportsVision: true,
      supportsStreaming: true,
      discoveredAt: 12345,
    });
  });

  it('builds provider-only settings updates without changing the global default model', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: {
        enabled: true,
        apiKey: 'old-secret',
        model: 'gpt-5.5',
      },
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
      displayName: 'OpenAI',
      model: 'gpt-5.5',
      temperature: 0.3,
      maxTokens: 8192,
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });
    const update = buildProviderSettingsUpdate('openai', providerConfig);

    expect(providerConfig).toMatchObject({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      apiKeyConfigured: true,
      updatedAt: 12345,
    });
    expect(providerConfig.apiKey).toBeUndefined();
    expect(update.models).toHaveProperty('providers.openai');
    expect(update.models).not.toHaveProperty('default');
    expect(update.models).not.toHaveProperty('defaultProvider');
  });

  it('persists provider icon and favorite without changing the global default model', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: { enabled: true },
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
      displayName: 'OpenAI',
      icon: 'GPT',
      favorite: true,
      model: 'gpt-5.5',
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });

    expect(providerConfig).toMatchObject({
      icon: 'GP',
      favorite: true,
      model: 'gpt-5.5',
    });
    expect(buildProviderSettingsUpdate('openai', providerConfig).models).not.toHaveProperty('defaultProvider');
  });

  it('preserves cloud-managed provider identity while allowing local favorite state', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: {
        enabled: true,
        managedByCloud: true,
        displayName: 'Team OpenAI Relay',
        icon: 'TO',
        favorite: false,
      },
      baseUrl: 'https://team-relay.example.com/v1',
      protocol: 'openai',
      displayName: 'Personal Alias',
      icon: 'PA',
      favorite: true,
      model: 'gpt-5.5',
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });

    expect(isProviderIdentityManaged(providerConfig)).toBe(true);
    expect(providerConfig).toMatchObject({
      managedByCloud: true,
      displayName: 'Team OpenAI Relay',
      icon: 'TO',
      favorite: true,
      model: 'gpt-5.5',
    });
  });

  it('persists provider image icons without truncating the data URL', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: { enabled: true },
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'openai',
      displayName: 'Relay',
      icon: tinyPngIcon,
      favorite: true,
      model: 'custom-model',
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });

    expect(providerConfig).toMatchObject({
      icon: tinyPngIcon,
      favorite: true,
      model: 'custom-model',
    });
    const [row] = buildProviderManagementRows({
      providers: [{
        id: 'custom',
        name: 'Custom Provider',
        description: 'OpenAI compatible',
        models: [{ id: 'custom-model', label: 'Custom Model' }],
      }],
      config: { ...config, provider: 'custom', model: 'custom-model' },
      providerConfigs: { custom: providerConfig },
    });
    expect(row).toMatchObject({
      icon: tinyPngIcon,
      favorite: true,
      name: 'Relay',
    });
  });

  it('persists provider icon asset references without truncating them as text', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: { enabled: true },
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'openai',
      displayName: 'Relay',
      icon: localIconAsset,
      favorite: true,
      model: 'custom-model',
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });

    expect(providerConfig).toMatchObject({
      icon: localIconAsset,
      favorite: true,
      model: 'custom-model',
    });
  });

  it('keeps invalid provider image data URLs out of saved settings with a readable warning', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: { enabled: true },
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'openai',
      displayName: 'Relay',
      icon: 'data:text/html;base64,PGgxPk5vPC9oMT4=',
      favorite: true,
      model: 'custom-model',
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });

    expect(providerConfig).toMatchObject({
      favorite: true,
      model: 'custom-model',
    });
    expect(providerConfig.icon).toBeUndefined();
    expect(describeProviderIconValidationError({
      valid: false,
      kind: 'invalid',
      reason: 'unsupported-data-url',
    })).toContain('base64 data:image');
  });

  it('builds explicit default model updates only for the set-default action', () => {
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: { enabled: true },
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      protocol: 'openai',
      model: 'mimo-v2.5-pro',
      apiKey: ' sk-test ',
      needsApiKey: true,
      hasStoredApiKey: false,
      updatedAt: 12345,
    });
    const update = buildDefaultModelSettingsUpdate('xiaomi', providerConfig);

    expect(providerConfig.apiKey).toBe('sk-test');
    expect(update.models).toMatchObject({
      default: 'xiaomi',
      defaultProvider: 'xiaomi',
      providers: {
        xiaomi: {
          model: 'mimo-v2.5-pro',
        },
      },
    });
  });

  it('preserves per-model thinking preferences through the provider save payload', () => {
    const models: NonNullable<ModelProviderSettings['models']> = {
      'gpt-5.5': {
        enabled: true,
        thinking: { enabled: true, effort: 'high' },
      },
    };
    const providerConfig = buildProviderConfigForSave({
      currentProviderConfig: { enabled: true, models },
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
      model: 'gpt-5.5',
      models,
      apiKey: '',
      needsApiKey: true,
      hasStoredApiKey: true,
      updatedAt: 12345,
    });

    expect(providerConfig.models?.['gpt-5.5']?.thinking).toEqual({
      enabled: true,
      effort: 'high',
    });
    expect(buildProviderSettingsUpdate('openai', providerConfig).models?.providers?.openai.models?.['gpt-5.5']?.thinking)
      .toEqual({ enabled: true, effort: 'high' });
  });

  it('creates stable unique ids for custom providers', () => {
    expect(createCustomProviderId('LongCat API', [])).toBe('custom-longcat-api');
    expect(createCustomProviderId('LongCat API', ['custom-longcat-api'])).toBe('custom-longcat-api-2');
  });

  it('detects when a built-in provider endpoint was changed to a relay', () => {
    expect(hasCustomEndpointOverride('openai', 'https://relay.example.com/v1')).toBe(true);
    expect(hasCustomEndpointOverride('openai', 'https://api.openai.com/v1/')).toBe(false);
    expect(hasCustomEndpointOverride('longcat', 'https://api.longcat.chat/anthropic/v1/', 'claude')).toBe(false);
    expect(hasCustomEndpointOverride('longcat', 'https://relay.example.com/v1', 'claude')).toBe(true);
    expect(hasCustomEndpointOverride('custom', 'https://relay.example.com/v1')).toBe(false);
    expect(hasCustomEndpointOverride('custom-relay', 'https://relay.example.com/v1')).toBe(false);
  });

  it('marks keyless providers in management rows so the list can show service readiness instead of "key ready"', () => {
    const localProvider = {
      id: 'local',
      name: 'Local (Ollama)',
      description: '本地 Ollama 服务',
      models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }],
    } satisfies ProviderInfo;

    const rows = buildProviderManagementRows({
      providers: [openaiProvider, localProvider],
      config,
      providerConfigs: {},
    });

    expect(rows.find((row) => row.id === 'openai')?.keyless).toBe(false);
    expect(rows.find((row) => row.id === 'local')?.keyless).toBe(true);
  });

  it('describes keyless provider readiness for the three probe states', () => {
    // 未探测完成 → 检测中（不能展示成已可用）
    expect(describeKeylessReadiness(undefined)).toEqual({
      state: 'checking',
      label: '检测本地服务…',
    });
    // 端点可达 → 真·已可用
    expect(describeKeylessReadiness(true)).toEqual({
      state: 'running',
      label: '✓ 本地服务',
    });
    // 端点不可达 → 明确标注服务未运行，而不是假性"已可用"
    expect(describeKeylessReadiness(false)).toEqual({
      state: 'unavailable',
      label: '服务未运行',
    });
  });

  it('promotes a freshly configured provider to default only when the current default model is unusable', () => {
    const savedConfig: ModelProviderSettings = { enabled: true, apiKeyConfigured: true, model: 'gpt-5.5' };
    // 出厂默认指针停在没 key 的 xiaomi → 配好 openai 后应自动接管默认
    const settingsWithDeadDefault = {
      models: {
        default: 'xiaomi',
        defaultProvider: 'xiaomi',
        providers: { xiaomi: { enabled: true } },
      },
    } as unknown as AppSettings;
    expect(shouldPromoteProviderToDefault('openai', savedConfig, settingsWithDeadDefault)).toBe(true);

    // 当前默认模型已可用 → 不抢默认
    const settingsWithLiveDefault = {
      models: {
        default: 'moonshot',
        defaultProvider: 'moonshot',
        providers: { moonshot: { enabled: true, apiKeyConfigured: true } },
      },
    } as unknown as AppSettings;
    expect(shouldPromoteProviderToDefault('openai', savedConfig, settingsWithLiveDefault)).toBe(false);

    // 刚保存的 provider 自己没配好 key / 被禁用 → 不 promote
    expect(shouldPromoteProviderToDefault('openai', { enabled: true }, settingsWithDeadDefault)).toBe(false);
    expect(shouldPromoteProviderToDefault('openai', { enabled: false, apiKeyConfigured: true }, settingsWithDeadDefault)).toBe(false);

    // 默认指针就是刚保存的 provider：保存后 settings 已可用 → 无需再切
    const settingsDefaultIsSelf = {
      models: {
        default: 'openai',
        defaultProvider: 'openai',
        providers: { openai: { enabled: true, apiKeyConfigured: true } },
      },
    } as unknown as AppSettings;
    expect(shouldPromoteProviderToDefault('openai', savedConfig, settingsDefaultIsSelf)).toBe(false);
  });

  it('treats local models as keyless and locks only built-in catalog metadata', () => {
    expect(providerRequiresApiKey('local')).toBe(false);
    expect(providerRequiresApiKey('longcat')).toBe(true);

    expect(isModelMetadataLocked('longcat', {
      id: 'LongCat-2.0-Preview',
      label: 'LongCat 2.0 Preview',
      enabled: true,
      capabilities: ['general', 'reasoning'],
      supportsTool: true,
      supportsVision: false,
      supportsStreaming: true,
      source: 'catalog',
    })).toBe(true);

    expect(isModelMetadataLocked('custom-longcat', {
      id: 'longcat-2.0-preview',
      label: 'LongCat 2.0 Preview',
      enabled: true,
      capabilities: ['general'],
      supportsTool: true,
      supportsVision: false,
      supportsStreaming: true,
      source: 'catalog',
    })).toBe(false);

    expect(isModelMetadataLocked('longcat', {
      id: 'LongCat-Flash-Lite',
      label: 'LongCat Flash Lite',
      enabled: true,
      capabilities: ['general'],
      supportsTool: true,
      supportsVision: false,
      supportsStreaming: true,
      source: 'discovered',
    })).toBe(false);
  });

  it('identifies legacy custom LongCat configs for official migration', () => {
    expect(normalizeLongCatModelId('longcat-2.0-preview')).toBe('LongCat-2.0-Preview');
    expect(isLegacyLongCatProviderConfig('custom', {
      enabled: true,
      displayName: 'LongCat',
      baseUrl: 'https://api.longcat.chat/openai/v1',
    })).toBe(true);
    expect(isLegacyLongCatProviderConfig('custom-relay', {
      enabled: true,
      displayName: 'LongCat',
      baseUrl: 'https://api.longcat.chat/openai/v1',
    })).toBe(false);
    const migration = buildLegacyLongCatProviderMigration(
      { provider: 'custom', model: 'longcat-2.0-preview' },
      { custom: { enabled: true, displayName: 'LongCat', baseUrl: 'https://api.longcat.chat/openai/v1' } },
    );
    expect(migration?.config).toMatchObject({ provider: 'longcat', model: 'LongCat-2.0-Preview' });
  });
});
