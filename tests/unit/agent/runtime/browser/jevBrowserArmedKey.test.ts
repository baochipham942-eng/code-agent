import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JevSystemOneCall } from '../../../../../src/shared/constants/jevQuestions';
import { JEV_MODEL } from '../../../../../src/shared/constants/jevQuestions';
import type { ToolContext } from '../../../../../src/host/tools/types';

const serviceKey = vi.hoisted(() => ({
  getServiceApiKey: vi.fn<(service: string) => string | undefined>(() => undefined),
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getServiceApiKey: (service: string) => serviceKey.getServiceApiKey(service),
    getApiKey: () => undefined,
    getSettings: () => ({}),
    onSettingsUpdated: () => () => {},
  }),
}));

vi.mock('../../../../../src/host/services/core/secureStorage', () => {
  const items = new Map<string, string>();
  return {
    getSecureStorage: () => ({
      getItem: async (key: string) => items.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        items.set(key, value);
      },
      removeItem: async (key: string) => {
        items.delete(key);
      },
      getApiKey: () => undefined,
      setApiKey: () => {},
      deleteApiKey: () => {},
    }),
  };
});

import { resolveProviderApiKey } from '../../../../../src/host/model/providers/providerResolution';
import {
  resolveBrowserJevStep,
} from '../../../../../src/host/agent/runtime/browser/jevBrowserStep';
import { BrowserTool } from '../../../../../src/host/tools/vision/BrowserTool';

const CAPTURED_MISSING_KEY_WARN =
  'CODE_AGENT_BROWSER_JEV_STEP 已开启但 TYPESAFE_API_KEY 缺失，Jev 步选不生效（走主模型逐步 Browser）';

const CAPTURED_UNARMED_RESULT = {
  success: false,
  error: 'Jev 步选未开启或未装配',
  metadata: {
    status: 'fallback',
    fallback: true,
    reason: 'unarmed',
    browserJevMode: 'unarmed',
  },
};

function context(requestPermission: ToolContext['requestPermission'] = async () => true): ToolContext {
  return {
    workingDirectory: '/tmp',
    sessionId: 's-armed',
    turnId: 't-armed',
    requestPermission,
  };
}

describe('jev browser key arming', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    serviceKey.getServiceApiKey.mockReset();
    serviceKey.getServiceApiKey.mockReturnValue(undefined);
  });

  it('仅钥匙串有 key 时 resolveProviderApiKey 读到该 key，步选装配出 driver', () => {
    vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '1');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    serviceKey.getServiceApiKey.mockImplementation((service) => (
      service === 'typesafe' ? 'kc-only-typesafe-key' : undefined
    ));

    expect(resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL })).toBe('kc-only-typesafe-key');

    const driver = resolveBrowserJevStep();
    expect(driver).toBeDefined();
    expect(typeof driver?.run).toBe('function');

    const systemOne = vi.fn(async () => ({
      operation: { choice: 'stop', confidence: 1 },
      target: { choice: 'no_target', confidence: 1 },
      done: { noul: 0 },
      risk: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const injected = resolveBrowserJevStep({ systemOne });
    expect(injected).toBeDefined();
    expect(typeof injected?.run).toBe('function');
  });

  it('钥匙串与环境变量同时存在时钥匙串优先', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'env-typesafe-key');
    serviceKey.getServiceApiKey.mockReturnValue('kc-typesafe-key');
    expect(resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL })).toBe('kc-typesafe-key');
  });

  it('只有环境变量时步选仍按今日方式装配', () => {
    vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '1');
    vi.stubEnv('TYPESAFE_API_KEY', 'env-only-typesafe-key');
    const driver = resolveBrowserJevStep();
    expect(resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL })).toBe('env-only-typesafe-key');
    expect(driver).toBeDefined();
  });

  it('钥匙串与环境变量都没有时，行为与改动前捕获值一致', async () => {
    vi.resetModules();
    vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '1');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    serviceKey.getServiceApiKey.mockReturnValue(undefined);
    const step = await import('../../../../../src/host/agent/runtime/browser/jevBrowserStep');
    const browser = await import('../../../../../src/host/tools/vision/BrowserTool');
    const resolution = await import('../../../../../src/host/model/providers/providerResolution');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolution.resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL })).toBe('');
    expect(step.resolveBrowserJevStep()).toBeUndefined();
    const executed = await browser.BrowserTool.execute({ action: 'execute_goal', task: 'click' }, context());
    expect(executed).toEqual(CAPTURED_UNARMED_RESULT);
    expect(step.jevBrowserStepUnarmedResult()).toEqual(CAPTURED_UNARMED_RESULT);
    expect(warn.mock.calls).toEqual([[CAPTURED_MISSING_KEY_WARN]]);
  });
});
