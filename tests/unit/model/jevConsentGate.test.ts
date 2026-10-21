// ============================================================================
// Jev 借用 OpenRouter key 的知情同意闸门（N-JEV-DEFAULT-ON-CONSENT ③）—— 端到端单测
// ----------------------------------------------------------------------------
// 不 mock typesafeProvider 本体：闸门逻辑（resolveJevKeys/resolveJevRoute/probe）与
// createProductionJevCall 都是真实代码，只 mock key 来源（providerResolution /
// configService）与 fetch。覆盖：未同意 ⇒ resolveJevRoute() null 且生产包装永不触达
// provider；总开关关 ⇒ 同；给出同意后 OpenRouter 路由恢复；路由不可用 warn 每原因
// 每进程至多一条（可区分）。反向变异靶子：删掉 resolveJevKeys 里的同意判定 ⇒
// 「未同意 ⇒ null / 零调用」用例必红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyState = vi.hoisted(() => ({
  typesafe: '',
  openrouter: undefined as string | undefined,
  jev: { enabled: true, openRouterConsent: false } as { enabled?: boolean; openRouterConsent?: boolean },
}));

const loggerWarns = vi.hoisted(() => [] as unknown[][]);

vi.mock('../../../src/host/model/providers/providerResolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/model/providers/providerResolution')>();
  return {
    ...actual,
    resolveProviderApiKey: (config: { provider?: string }) => (
      config?.provider === 'typesafe' ? keyState.typesafe : ''
    ),
  };
});

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: (provider: string) => (provider === 'openrouter' ? keyState.openrouter : undefined),
    getSettings: () => ({ jev: keyState.jev }),
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => { loggerWarns.push(args); },
    error: () => {},
  }),
}));

import { probeJevKeySource, resolveJevRoute } from '../../../src/host/model/providers/typesafeProvider';
import { createProductionJevCall, getJevStatus } from '../../../src/host/model/jevFeatures';

const OPENROUTER = 'openrouter-key-gate';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  keyState.typesafe = '';
  keyState.openrouter = undefined;
  keyState.jev = { enabled: true, openRouterConsent: false };
  loggerWarns.length = 0;
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

describe('OpenRouter 借用同意闸门', () => {
  it('未同意：resolveJevRoute() null，createProductionJevCall 永不触达 provider（零 fetch）', async () => {
    keyState.openrouter = OPENROUTER;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    expect(resolveJevRoute()).toBeNull();
    expect(probeJevKeySource()).toBe('openrouter_pending_consent');

    const call = createProductionJevCall('permissionClassifier');
    await expect(call({}, {}, {})).rejects.toMatchObject({ code: 'TYPESAFE_KEY_MISSING' });

    expect(fetchMock).not.toHaveBeenCalled();

    // 路由层留痕：原因可区分（说「尚未允许借用」）且每原因每进程至多一条——
    // 上面已调用过 resolveJevRoute，这里再调两次也只有同一条 warn。
    resolveJevRoute();
    resolveJevRoute();
    const routeWarns = loggerWarns.filter((args) => String(args[0]).includes('openrouter_pending_consent'));
    expect(routeWarns).toHaveLength(1);
    expect(String(routeWarns[0][0])).toContain('尚未允许借用');

    // 特性级降级 warn 同样可区分原因：说「尚未允许借用」，不误报「未配置」。
    const featureWarn = loggerWarns.find((args) => String(args[0]).includes('CODE_AGENT_PERMISSION_LLM_CLASSIFIER'));
    expect(String(featureWarn?.[0])).toContain('尚未允许借用');
    expect(String(featureWarn?.[0])).not.toContain('均未配置');

    // 降级状态可观测：keySource 上报待同意，特性 effective=false 且计数累加。
    const status = getJevStatus();
    expect(status.keySource).toBe('openrouter_pending_consent');
    expect(status.keyConfigured).toBe(false);
    expect(status.features.permissionClassifier.effective).toBe(false);
    expect(status.features.permissionClassifier.degradedCount).toBeGreaterThanOrEqual(1);
  });

  it('总开关关：即使有官方 key 也视同无 key，warn 说用户关闭（且只一条）', () => {
    keyState.typesafe = 'official-key-gate';
    keyState.jev = { enabled: false };
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    expect(probeJevKeySource()).toBe('disabled_by_user');
    expect(resolveJevRoute()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveJevRoute();
    const warns = loggerWarns.filter((args) => String(args[0]).includes('disabled_by_user'));
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('关闭 Jev 总开关');
  });

  it('给出同意后：OpenRouter 路由恢复，生产包装触达 provider', async () => {
    keyState.openrouter = OPENROUTER;
    keyState.jev = { enabled: true, openRouterConsent: true };
    const answers = { needs_human: { noul: 0.2 } };
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ answers }),
      { status: 200 },
    )) as unknown as typeof fetch;

    expect(probeJevKeySource()).toBe('openrouter');
    expect(resolveJevRoute()).toMatchObject({ kind: 'openrouter', apiKey: OPENROUTER });
    const call = createProductionJevCall('router');
    await expect(call({}, {}, {})).resolves.toEqual(answers);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('官方 key 不需要 OpenRouter 同意（同意只闸借用）', () => {
    keyState.typesafe = 'official-key-gate';
    keyState.jev = { enabled: true, openRouterConsent: false };
    expect(probeJevKeySource()).toBe('official');
    expect(resolveJevRoute()).toMatchObject({ kind: 'official' });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
