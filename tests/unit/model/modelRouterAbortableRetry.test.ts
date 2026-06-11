// ============================================================================
// ModelRouter — selected artifact provider 重试退避的可中断性
// （codex audit R2 对称应用：abort 后不得继续等待或重试）
//
// 测试态 ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS 是 [0,0]，观察不到退避行为，
// 故本文件单独 mock 成 60s 长延迟：abort 必须立即唤醒，否则 race 哨兵先到。
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { ModelRouter } from '../../../src/main/model/modelRouter';
import type { ModelConfig } from '../../../src/shared/contract';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/main/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({
    getHealth: vi.fn().mockReturnValue(null),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  }),
}));

vi.mock('../../../src/main/model/modelRouterTimeouts', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/model/modelRouterTimeouts')>();
  return { ...actual, ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS: [60_000, 60_000] };
});

vi.mock('../../../src/main/services/core/configService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/core/configService')>();
  return {
    ...actual,
    getConfigService: () => ({
      getSettings: () => ({}),
      getApiKey: () => 'sk-fallback-key', // fallback 链有 key 可走 → 暴露"带 abort 信号继续 fallback"的 bug
    }),
  };
});

describe('ModelRouter — retrySelectedProviderForArtifactTransient 退避可中断', () => {
  it('退避等待期间 abort：立即返回 null，不再调 provider 重试', async () => {
    const router = new ModelRouter();
    const callMock = vi.fn();
    (router as unknown as { _callProviderWithArtifactFallback: typeof callMock })
      ._callProviderWithArtifactFallback = callMock;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const retryPromise = (router as unknown as {
      retrySelectedProviderForArtifactTransient: (
        ...args: unknown[]
      ) => Promise<unknown>;
    }).retrySelectedProviderForArtifactTransient(
      [{ role: 'user', content: 'hi' }],
      [],
      { provider: 'xiaomi', model: 'mimo-v2.5-pro' } as ModelConfig,
      'network',
      undefined,
      controller.signal,
      undefined,
    );

    // 哨兵 1s：若 abort 没有唤醒 60s 退避，哨兵先到 → 失败
    const result = await Promise.race([
      retryPromise,
      new Promise((resolve) => setTimeout(() => resolve('STILL_SLEEPING_AFTER_ABORT'), 1_000)),
    ]);

    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });
});

describe('ModelRouter — 公共 inference() 的取消形态（codex re-audit MED）', () => {
  it('artifact 重试退避中 abort：以取消错误上抛，不带 abort 信号跑 fallback 链', async () => {
    const router = new ModelRouter();
    const callMock = vi.fn().mockRejectedValue(new Error('502 Bad Gateway'));
    (router as unknown as { _callProviderWithArtifactFallback: typeof callMock })
      ._callProviderWithArtifactFallback = callMock;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    // artifact-like（带 repair 上下文标记）+ adaptive=true（允许跨 provider fallback）
    // + artifactRepairActive：主调用 502 → 选定 provider 重试 → 60s 退避中 abort
    const inferencePromise = router.inference(
      [{ role: 'user', content: '<artifact-repair-context> fix the game artifact, full html required.' }],
      [],
      { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: 'sk-test', adaptive: true } as ModelConfig,
      undefined,
      controller.signal,
      { artifactRepairActive: true },
    );

    const result = await Promise.race([
      inferencePromise.then(
        () => 'RESOLVED_UNEXPECTEDLY',
        (err: Error) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve('STILL_SLEEPING_AFTER_ABORT'), 2_000)),
    ]);

    // 取消必须以取消形态上抛——不是原始 502，也不是默默跑完 fallback 链
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/cancel/i);
    // 主调用 1 次后即取消：不允许再向任何 provider（重试或 fallback）发请求
    expect(callMock).toHaveBeenCalledTimes(1);
  });
});
