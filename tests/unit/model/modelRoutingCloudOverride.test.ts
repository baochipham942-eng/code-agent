import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_FALLBACK_CHAIN } from '../../../src/shared/constants';
import type { ModelMessage } from '../../../src/host/model/types';
import type { ModelProvider } from '../../../src/shared/contract';
import {
  getFallbackChainForRequest,
  resetModelRoutingOverride,
  setModelRoutingOverride,
} from '../../../src/host/model/modelRouterPolicy';
import { AdaptiveRouter } from '../../../src/host/model/adaptiveRouter';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// 非 artifact 消息：避开 getFallbackChainForRequest 的 artifact 重排分支，纯看 chain 来源
const plainMessages: ModelMessage[] = [{ role: 'user', content: '你好' }];
// 动态取一个真实存在的 provider key，不硬编码易变列表
const provider = Object.keys(PROVIDER_FALLBACK_CHAIN)[0] as ModelProvider;

describe('model routing cloud override（云端可调降级链 + 兜底铁律）', () => {
  afterEach(() => {
    resetModelRoutingOverride();
  });

  it('云端 override 设了该 provider 的链时，返回云端的链', () => {
    const cloudChain = [{ provider: 'cloud-prov', model: 'cloud-model' }];
    setModelRoutingOverride({ fallbackChain: { [provider]: cloudChain } });
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual(cloudChain);
  });

  it('没有 override 时，降级到硬编码链', () => {
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual(
      PROVIDER_FALLBACK_CHAIN[provider],
    );
  });

  it('override 不含该 provider 时，该 provider 降级到硬编码链', () => {
    setModelRoutingOverride({
      fallbackChain: { 'some-other-provider': [{ provider: 'x', model: 'y' }] },
    });
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual(
      PROVIDER_FALLBACK_CHAIN[provider],
    );
  });

  it('override 畸形（空数组 / 非数组）时，降级到硬编码链', () => {
    setModelRoutingOverride({ fallbackChain: { [provider]: [] } });
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual(
      PROVIDER_FALLBACK_CHAIN[provider],
    );

    setModelRoutingOverride({ fallbackChain: { [provider]: 'nope' as unknown as [] } });
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual(
      PROVIDER_FALLBACK_CHAIN[provider],
    );
  });

  it('override 数组里混入畸形项时，过滤畸形项后保留合法项', () => {
    setModelRoutingOverride({
      fallbackChain: {
        [provider]: [
          { provider: 'good', model: 'm1' },
          { provider: 'no-model' } as unknown as { provider: string; model: string },
          { model: 'no-provider' } as unknown as { provider: string; model: string },
        ],
      },
    });
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual([
      { provider: 'good', model: 'm1' },
    ]);
  });

  it('resetModelRoutingOverride 恢复硬编码行为', () => {
    setModelRoutingOverride({ fallbackChain: { [provider]: [{ provider: 'c', model: 'm' }] } });
    resetModelRoutingOverride();
    expect(getFallbackChainForRequest(plainMessages, provider)).toEqual(
      PROVIDER_FALLBACK_CHAIN[provider],
    );
  });
});

describe('AdaptiveRouter 也走云端 override 链（路由各处一致生效）', () => {
  afterEach(() => {
    resetModelRoutingOverride();
  });

  it('rate_limit 降级时用云端 override 的链选 provider', () => {
    setModelRoutingOverride({
      fallbackChain: { moonshot: [{ provider: 'override-prov', model: 'override-model' }] },
    });
    const router = new AdaptiveRouter();
    const result = router.selectFallback({
      reason: 'rate_limit',
      currentModel: 'kimi-k2.5',
      currentProvider: 'moonshot',
    });
    expect(result?.provider).toBe('override-prov');
    expect(result?.model).toBe('override-model');
  });
});
