import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  resolveModelConfig,
  resolveRunModelConfig,
  getDefaultModelByProvider,
  getPermissionLevel,
} from '../../../../src/host/agent/orchestrator/modelConfigResolver';
import type { ConfigService } from '../../../../src/host/services/core/configService';
import type { PermissionRequest } from '../../../../src/shared/contract';
import { getModelSessionState, resetModelSessionState } from '../../../../src/host/session/modelSessionState';

describe('modelConfigResolver', () => {
  afterEach(() => resetModelSessionState());

  describe('getPermissionLevel', () => {
    it.each([
      ['file_read', 'read'],
      ['file_write', 'write'],
      ['file_edit', 'write'],
      ['command', 'execute'],
      ['dangerous_command', 'execute'],
      ['network', 'network'],
    ])('权限类型 %s → 级别 %s', (type, level) => {
      expect(getPermissionLevel(type as PermissionRequest['type'])).toBe(level);
    });

    it('未知权限类型兜底为 read（最小权限）', () => {
      expect(getPermissionLevel('weird' as unknown as PermissionRequest['type'])).toBe('read');
    });
  });

  describe('getDefaultModelByProvider', () => {
    it('已知 provider 返回非空模型名', () => {
      const model = getDefaultModelByProvider('deepseek');
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    });

    it('未知 provider 兜底到 DEFAULT_MODELS.chat（仍为非空字符串）', () => {
      const model = getDefaultModelByProvider('nonexistent-provider-xyz');
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    });
  });

  describe('resolveModelConfig', () => {
    const settings = {
      models: {
        defaultProvider: 'deepseek',
        providers: {
          deepseek: {
            model: 'deepseek-chat',
            maxTokens: 8192,
            baseUrl: 'https://api.deepseek.com',
            protocol: 'openai',
          },
        },
      },
    } as unknown as ReturnType<ConfigService['getSettings']>;

    it('解析用户选中的 provider/model，并带上 apiKey 与硬编码 temperature=0.7', () => {
      const configService = { getApiKey: vi.fn(() => 'sk-test') } as unknown as ConfigService;
      const cfg = resolveModelConfig(configService, settings);
      expect(cfg.model).toBe('deepseek-chat');
      expect(cfg.apiKey).toBe('sk-test');
      expect(cfg.temperature).toBe(0.7);
      expect(cfg.maxTokens).toBe(8192);
      expect(cfg.baseUrl).toBe('https://api.deepseek.com');
      expect(cfg.protocol).toBe('openai');
      expect(configService.getApiKey).toHaveBeenCalled();
    });

    it('未配置 API Key 时仍返回完整 config（apiKey 为空，不抛错）', () => {
      const configService = { getApiKey: vi.fn(() => undefined) } as unknown as ConfigService;
      const cfg = resolveModelConfig(configService, settings);
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.model).toBe('deepseek-chat');
      expect(cfg.temperature).toBe(0.7);
    });
  });

  describe('resolveRunModelConfig', () => {
    it('queued modelSpec wins over a changed session override', () => {
      getModelSessionState().setOverride('session-queued-model', {
        provider: 'longcat',
        model: 'LongCat-Flash-Chat',
      });
      const configService = { getApiKey: vi.fn(() => 'sk-test') } as unknown as ConfigService;
      const settings = {
        models: {
          defaultProvider: 'deepseek',
          providers: {
            deepseek: { model: 'deepseek-chat' },
            xiaomi: { model: 'mimo-v2.5-pro' },
          },
        },
      } as unknown as ReturnType<ConfigService['getSettings']>;

      const config = resolveRunModelConfig(
        configService,
        settings,
        'session-queued-model',
        { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      );

      expect(config).toMatchObject({
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        adaptive: false,
      });
    });

    // 换 provider 必须把 baseUrl/apiKey 一起换掉。继承上一个 provider 的值会导致
    // 「拿 A 家的 key 打 B 家的端点」——既永远认证失败，也是把凭据发给第三方。
    // 目标 provider 没单独配时留 undefined，由 providerResolution 按 provider 补默认端点。
    const switchSettings = {
      models: {
        defaultProvider: 'zhipu',
        providers: {
          zhipu: { model: 'glm-5', baseUrl: 'https://api.0ki.cn/api/paas/v4' },
          deepseek: { model: 'deepseek-v4-flash' }, // 没有 baseUrl
        },
      },
    } as unknown as ReturnType<ConfigService['getSettings']>;
    // 只有默认 provider 配了 key，切过去的那家没配
    const switchConfigService = {
      getApiKey: vi.fn((provider: string) => (provider === 'zhipu' ? 'sk-zhipu' : undefined)),
    } as unknown as ConfigService;

    it('session override 换 provider 后，不继承上一个 provider 的 baseUrl/apiKey', () => {
      getModelSessionState().setOverride('session-switch', {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      });

      const config = resolveRunModelConfig(switchConfigService, switchSettings, 'session-switch');

      expect(config.provider).toBe('deepseek');
      expect(config.baseUrl).not.toBe('https://api.0ki.cn/api/paas/v4');
      expect(config.baseUrl).toBeUndefined();
      expect(config.apiKey).not.toBe('sk-zhipu');
      expect(config.apiKey).toBeUndefined();
    });

    it('explicit modelSpec 换 provider 后，同样不继承上一个 provider 的 baseUrl/apiKey', () => {
      const config = resolveRunModelConfig(switchConfigService, switchSettings, null, {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      });

      expect(config.provider).toBe('deepseek');
      expect(config.baseUrl).not.toBe('https://api.0ki.cn/api/paas/v4');
      expect(config.baseUrl).toBeUndefined();
      expect(config.apiKey).not.toBe('sk-zhipu');
      expect(config.apiKey).toBeUndefined();
    });
  });
});
