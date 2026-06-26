import { describe, it, expect, vi } from 'vitest';
import {
  resolveModelConfig,
  getDefaultModelByProvider,
  getPermissionLevel,
} from '../../../../src/host/agent/orchestrator/modelConfigResolver';
import type { ConfigService } from '../../../../src/host/services/core/configService';
import type { PermissionRequest } from '../../../../src/shared/contract';

describe('modelConfigResolver', () => {
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
});
