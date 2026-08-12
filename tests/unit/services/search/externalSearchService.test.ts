import { describe, expect, it, vi } from 'vitest';
import {
  ExternalSearchService,
  hasConfiguredExternalSearchCredential,
  type SearchSourcePreference,
} from '../../../../src/host/services/search/searchSourceRegistry';

const zhipuResponse = {
  search_result: [{ title: 'Zhipu', link: 'https://zhipu.example/result', content: 'zhipu snippet', publish_date: '2026-08-12' }],
};
const minimaxResponse = {
  organic: [{ title: 'MiniMax', link: 'https://minimax.example/result', snippet: 'minimax snippet', date: '2026-08-12' }],
  base_resp: { status_code: 0, status_msg: 'ok' },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function service(env: Record<string, string | undefined>, fetchImpl = vi.fn()): ExternalSearchService {
  return new ExternalSearchService({ env, fetch: fetchImpl as typeof fetch, now: () => 1000 });
}

describe('external search sources', () => {
  it('does not consider a source without its dedicated search credential', async () => {
    // 模型 key 不是搜索 key：配了 ZHIPU_API_KEY / MINIMAX_API_KEY 也不算配了搜索凭据。
    const probe = vi.fn();
    const subject = service({ ZHIPU_API_KEY: 'proxy-key', MINIMAX_API_KEY: 'model-key' }, probe);

    await expect(subject.search('auto', 'q')).rejects.toMatchObject({ reason: 'no_credential' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('never fires a synthetic readiness probe — readiness is judged by the real search', async () => {
    // 探活 = 一次真实付费检索（智谱 0.05 元/次）。只准发用户那一次查询，不准多发。
    const fetchImpl = vi.fn().mockResolvedValue(response(zhipuResponse));
    const subject = service({ ZHIPU_OFFICIAL_API_KEY: 'official' }, fetchImpl);

    expect(subject.getReadiness('zhipu')).toMatchObject({ ready: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    await subject.search('auto', 'latest Neo');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? ''))).toMatchObject({ search_query: 'latest Neo' });
  });

  it('classifies an invalid credential and stops selecting it within the TTL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: '1113' } }, 401));
    const subject = service({ ZHIPU_OFFICIAL_API_KEY: 'bad' }, fetchImpl);

    await expect(subject.search('zhipu', 'q')).rejects.toMatchObject({ reason: 'insufficient_balance' });
    expect(subject.getReadiness('zhipu')).toMatchObject({ ready: false, reason: 'insufficient_balance' });
  });

  it('uses Zhipu independent web search endpoint and fixed sogou engine', async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      void init;
      return Promise.resolve(response(url.includes('minimaxi.com') ? minimaxResponse : zhipuResponse));
    });
    const subject = service({ ZHIPU_OFFICIAL_API_KEY: 'official' }, fetchImpl);

    await expect(subject.search('zhipu', 'latest Neo')).resolves.toMatchObject({ source: 'zhipu', results: [{ title: 'Zhipu', url: 'https://zhipu.example/result' }] });
    expect(fetchImpl).toHaveBeenCalledWith('https://open.bigmodel.cn/api/paas/v4/web_search', expect.objectContaining({ method: 'POST' }));
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body ?? ''))).toMatchObject({ search_engine: 'search_pro_sogou', search_query: 'latest Neo', count: 10 });
  });

  it('normalizes MiniMax organic results and fails a non-zero base_resp status', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(minimaxResponse)).mockResolvedValueOnce(response({ organic: [], base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }));
    const subject = service({ MINIMAX_SEARCH_API_KEY: 'token-plan' }, fetchImpl);

    await expect(subject.search('minimax', 'latest Neo')).resolves.toMatchObject({ source: 'minimax', results: [{ title: 'MiniMax', url: 'https://minimax.example/result' }] });
    await expect(subject.search('minimax', 'latest Neo')).rejects.toMatchObject({ reason: 'insufficient_balance' });
  });

  it('chooses Zhipu in auto, honors a pinned ready source, and never silently falls back from a pinned failure', async () => {
    const fetchImpl = vi.fn((url: string) => Promise.resolve(response(url.includes('minimaxi.com') ? minimaxResponse : zhipuResponse)));
    const subject = service({ ZHIPU_OFFICIAL_API_KEY: 'official', MINIMAX_SEARCH_API_KEY: 'token-plan' }, fetchImpl);

    await expect(subject.search('auto' satisfies SearchSourcePreference, 'q')).resolves.toMatchObject({ source: 'zhipu' });
    await expect(subject.search('minimax', 'q')).resolves.toMatchObject({ source: 'minimax' });
    // 固定了 minimax 却没有它的凭据 —— 必须报错，不许悄悄改用智谱。
    const unavailable = service({ ZHIPU_OFFICIAL_API_KEY: 'official' }, fetchImpl);
    await expect(unavailable.search('minimax', 'q')).rejects.toMatchObject({ reason: 'no_credential', source: 'minimax' });
  });
});

describe('settings-configured search credentials', () => {
  function authHeader(fetchImpl: ReturnType<typeof vi.fn>): string | undefined {
    return (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization;
  }

  it('uses the settings-configured key when env is empty', async () => {
    // 设置这条路真的通了：env 为空也能搜，且带上的是设置里的那把 key。
    const fetchImpl = vi.fn().mockResolvedValue(response(zhipuResponse));
    const subject = new ExternalSearchService({
      env: {},
      fetch: fetchImpl as typeof fetch,
      now: () => 1000,
      getServiceApiKey: (service) => (service === 'zhipu-search' ? 'settings-zhipu-key' : undefined),
    });

    await expect(subject.search('zhipu', 'q')).resolves.toMatchObject({ source: 'zhipu' });
    expect(authHeader(fetchImpl)).toBe('Bearer settings-zhipu-key');
  });

  it('falls back to env when no settings key is configured', async () => {
    // env 兜底没被破坏：设置里没配、env 有值 → 用 env 那把。
    const fetchImpl = vi.fn().mockResolvedValue(response(minimaxResponse));
    const subject = new ExternalSearchService({
      env: { MINIMAX_SEARCH_API_KEY: 'env-minimax-key' },
      fetch: fetchImpl as typeof fetch,
      now: () => 1000,
      getServiceApiKey: () => undefined,
    });

    await expect(subject.search('minimax', 'q')).resolves.toMatchObject({ source: 'minimax' });
    expect(authHeader(fetchImpl)).toBe('Bearer env-minimax-key');
  });

  it('prefers the settings key over the env fallback', async () => {
    // 两者都有 → 用设置里的那把。
    const fetchImpl = vi.fn().mockResolvedValue(response(zhipuResponse));
    const subject = new ExternalSearchService({
      env: { ZHIPU_OFFICIAL_API_KEY: 'env-zhipu-key' },
      fetch: fetchImpl as typeof fetch,
      now: () => 1000,
      getServiceApiKey: (service) => (service === 'zhipu-search' ? 'settings-zhipu-key' : undefined),
    });

    await expect(subject.search('zhipu', 'q')).resolves.toMatchObject({ source: 'zhipu' });
    expect(authHeader(fetchImpl)).toBe('Bearer settings-zhipu-key');
  });

  it('marks the source unavailable and fails the sync pre-filter when neither is configured', () => {
    const subject = new ExternalSearchService({
      env: {},
      fetch: vi.fn() as typeof fetch,
      now: () => 1000,
      getServiceApiKey: () => undefined,
    });

    expect(subject.getReadiness('zhipu')).toMatchObject({ ready: false, reason: 'no_credential' });
    expect(subject.getReadiness('minimax')).toMatchObject({ ready: false, reason: 'no_credential' });
    expect(hasConfiguredExternalSearchCredential({}, () => undefined)).toBe(false);
  });

  it('sees the settings-configured key in the sync pre-filter so the tool enters the tool table', () => {
    expect(
      hasConfiguredExternalSearchCredential({}, (service) => (service === 'minimax-search' ? 'settings-minimax-key' : undefined)),
    ).toBe(true);
  });

  it('a configured model key is not a search credential', async () => {
    // 🔴 本单最重要的负向判据：只配了模型 key（zhipu/minimax provider）时，
    // getServiceApiKey 的 'zhipu-search'/'minimax-search' 与模型 key 是两把，
    // 取不到任何值 —— 搜索源必须仍不可用，env 里的模型 key 变量也不算数。
    const fetchImpl = vi.fn();
    const subject = new ExternalSearchService({
      env: { ZHIPU_API_KEY: 'model-key', MINIMAX_API_KEY: 'model-key' },
      fetch: fetchImpl as typeof fetch,
      now: () => 1000,
      getServiceApiKey: () => undefined,
    });

    await expect(subject.search('auto', 'q')).rejects.toMatchObject({ reason: 'no_credential' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hasConfiguredExternalSearchCredential({ ZHIPU_API_KEY: 'model-key', MINIMAX_API_KEY: 'model-key' }, () => undefined)).toBe(false);
  });
});
