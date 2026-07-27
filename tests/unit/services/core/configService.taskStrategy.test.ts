import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../../../src/shared/contract';

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => []),
};

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
  secureStorageMock.getSettingsFromKeychain.mockClear();
  secureStorageMock.saveSettingsToKeychain.mockClear();
  secureStorageMock.getApiKey.mockClear();

  vi.doMock('../../../../src/host/platform', () => ({
    app: {
      isPackaged: false,
      getPath: () => dataDir,
    },
  }));
  vi.doMock('../../../../src/host/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
  }));
  vi.doMock('../../../../src/host/services/infra/logger', () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }));
  vi.doMock('../../../../src/host/permissions/policyEngine', () => ({
    getPolicyEngine: () => ({
      loadUserRules: vi.fn(),
    }),
  }));
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides: vi.fn(),
  }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({
    setProviderProxyOverrides: vi.fn(),
  }));

  return import('../../../../src/host/services/core/configService');
}

describe('ConfigService task strategy migration', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('adds a missing built-in artifact rule and resolves a legacy artifact turn above fast', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-task-strategy-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      models: {
        taskStrategy: {
          mode: 'auto',
          defaultProfile: 'fast',
          rules: [
            { id: 'simple-chat-fast', label: '短问答', intent: 'simple_chat', enabled: true, profile: 'fast', reason: 'legacy' },
            { id: 'code-main', label: '代码任务', intent: 'coding', enabled: true, profile: 'main', reason: 'legacy' },
            { id: 'research-deep', label: '研究任务', intent: 'research', enabled: true, profile: 'deep', reason: 'legacy' },
            { id: 'vision-route', label: '视觉任务', intent: 'vision', enabled: true, profile: 'vision', reason: 'legacy' },
          ],
        },
      },
    }));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    const strategy = service.getSettings().models.taskStrategy;
    expect(strategy?.rules.find((rule) => rule.id === 'artifact-main')).toMatchObject({
      enabled: true,
      intent: 'artifact',
      profile: 'main',
    });

    const { resolveModelDecision } = await import('../../../../src/host/model/modelDecision');
    const requestedConfig = {
      provider: 'moonshot',
      model: 'kimi-k2.5',
      adaptive: true,
      maxTokens: 8192,
    } as ModelConfig;
    const { config, decision } = resolveModelDecision({
      requestedConfig,
      messages: [{ role: 'user', content: '帮我做个 PPT' }],
      context: 'main-chat',
      taskStrategy: strategy,
    });

    expect(decision.strategyProfile).toBe('main');
    expect(decision.strategyRuleId).toBe('artifact-main');
    expect(config.provider).toBe(strategy?.profiles.main.provider);
    expect(config.model).toBe(strategy?.profiles.main.model);
    expect(config.provider).not.toBe(strategy?.profiles.fast.provider);
    expect(config.model).not.toBe(strategy?.profiles.fast.model);
  });
});
