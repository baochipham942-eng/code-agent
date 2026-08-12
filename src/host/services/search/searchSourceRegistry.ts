// External search is deliberately independent from modelCapabilityMatrix: these
// APIs return structured results and use credentials unrelated to model keys.

import type { ServiceApiKey } from '../../../shared/contract/configService';

export type ExternalSearchSourceId = 'zhipu' | 'minimax';
export type SearchSourcePreference = 'auto' | ExternalSearchSourceId;
export type SearchSourceFailureReason = 'no_credential' | 'invalid_credential' | 'insufficient_balance' | 'rate_limited' | 'network_error';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  date?: string;
  source: ExternalSearchSourceId;
}

export interface SearchSource {
  id: ExternalSearchSourceId;
  label: string;
  credentialEnv: 'ZHIPU_OFFICIAL_API_KEY' | 'MINIMAX_SEARCH_API_KEY';
  /**
   * 设置页（SecureStorage）里的独立搜索凭据 id。
   * 故意不复用 'zhipu'/'minimax' —— 那是模型 provider 的 key，与搜索凭据是两把。
   */
  serviceKeyId: 'zhipu-search' | 'minimax-search';
  priority: number;
}

export interface SearchSourceReadiness {
  source: ExternalSearchSourceId;
  ready: boolean;
  reason?: SearchSourceFailureReason;
  checkedAt: number;
}

export class ExternalSearchError extends Error {
  constructor(readonly source: ExternalSearchSourceId, readonly reason: SearchSourceFailureReason, message: string) {
    super(message);
    this.name = 'ExternalSearchError';
  }
}

const SEARCH_SOURCES: readonly SearchSource[] = [
  { id: 'zhipu', label: '智谱', credentialEnv: 'ZHIPU_OFFICIAL_API_KEY', serviceKeyId: 'zhipu-search', priority: 1 },
  // Token Plan quota is shared with the Lobster daily pipeline; keep it second.
  { id: 'minimax', label: 'MiniMax', credentialEnv: 'MINIMAX_SEARCH_API_KEY', serviceKeyId: 'minimax-search', priority: 2 },
];

/**
 * 同步工具表只能据此做初筛；真正可用性仍由 30 分钟探活缓存裁决。
 * 凭据两处都算数：设置页配的 key（getServiceApiKey 注入，优先）+ 环境变量兜底。
 */
export function hasConfiguredExternalSearchCredential(
  env: NodeJS.ProcessEnv = process.env,
  getServiceApiKey?: (service: ServiceApiKey) => string | undefined,
): boolean {
  return SEARCH_SOURCES.some((source) => Boolean(
    getServiceApiKey?.(source.serviceKeyId)?.trim() || env[source.credentialEnv]?.trim(),
  ));
}

const TTL_MS = 30 * 60 * 1000;

function failureReason(status: number | undefined, body: string): SearchSourceFailureReason {
  const text = body.toLowerCase();
  if (status === 429 || /rate.?limit|too many/.test(text)) return 'rate_limited';
  if (/1113|balance|insufficient/.test(text)) return 'insufficient_balance';
  if (status === 401 || status === 403 || /invalid.*key|unauthori[sz]ed/.test(text)) return 'invalid_credential';
  return 'network_error';
}

/** 失败缓存挂在实例上，必须复用同一个实例，否则 TTL 形同虚设。 */
let shared: ExternalSearchService | undefined;
/**
 * deps 只在首次创建时生效（单例语义）。生产注入点见 externalSearch.ts ——
 * 它把 configService.getServiceApiKey 绑进来，让「设置页配的 key」对共享实例生效。
 */
export function getExternalSearchService(deps?: ExternalSearchServiceDeps): ExternalSearchService {
  shared ??= new ExternalSearchService(deps);
  return shared;
}

export interface ExternalSearchServiceDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  /** 设置页（SecureStorage）读服务 key 的注入点；缺省时只走 env。 */
  getServiceApiKey?: (service: ServiceApiKey) => string | undefined;
}

export class ExternalSearchService {
  private readonly readiness = new Map<ExternalSearchSourceId, SearchSourceReadiness>();

  constructor(private readonly deps: ExternalSearchServiceDeps = {}) {}

  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  private get fetch(): typeof fetch { return this.deps.fetch ?? globalThis.fetch; }
  private get now(): number { return (this.deps.now ?? Date.now)(); }
  private source(id: ExternalSearchSourceId): SearchSource {
    const found = SEARCH_SOURCES.find((candidate) => candidate.id === id);
    // id 是联合类型，注册表漏一项就是编码错误，不该走运行时兜底 —— 直接炸，别静默。
    if (!found) throw new Error(`未注册的搜索源：${id}`);
    return found;
  }
  /** 凭据：设置页配的 key 优先，环境变量兜底（与 brave/firecrawl 同形态）。 */
  private key(id: ExternalSearchSourceId): string | undefined {
    const source = this.source(id);
    return this.deps.getServiceApiKey?.(source.serviceKeyId)?.trim() || this.env[source.credentialEnv]?.trim() || undefined;
  }

  /**
   * 就绪状态**不主动探活**：探活等于一次真实付费检索（智谱 0.05 元/次），拿一个无意义的
   * 查询串去烧钱、还污染对方的检索日志。改用「真实搜索的结果就是就绪信号」——
   * 失败时记下原因并在 TTL 内不再选它，成功即视为就绪。
   */
  getReadiness(id: ExternalSearchSourceId): SearchSourceReadiness {
    if (!this.key(id)) return { source: id, ready: false, reason: 'no_credential', checkedAt: this.now };
    const cached = this.readiness.get(id);
    if (cached && !cached.ready && this.now - cached.checkedAt < TTL_MS) return cached;
    return { source: id, ready: true, checkedAt: this.now };
  }

  private candidates(): SearchSource[] {
    return SEARCH_SOURCES.filter((source) => this.getReadiness(source.id).ready).sort((a, b) => a.priority - b.priority);
  }

  /**
   * pinned 源失败**绝不静默改用另一家**——用户以为在用 A 实际在用 B 是更坏的结果。
   * auto 才按优先级顺延。
   */
  async search(preference: SearchSourcePreference, query: string): Promise<{ source: ExternalSearchSourceId; results: SearchResultItem[] }> {
    if (preference !== 'auto') {
      const readiness = this.getReadiness(preference);
      if (!readiness.ready) {
        throw new ExternalSearchError(preference, readiness.reason ?? 'network_error', `${this.source(preference).label} 搜索不可用（${readiness.reason}）`);
      }
      return { source: preference, results: await this.attempt(preference, query) };
    }

    const candidates = this.candidates();
    if (!candidates.length) throw new ExternalSearchError('zhipu', 'no_credential', '没有可用的外部搜索源');
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return { source: candidate.id, results: await this.attempt(candidate.id, query) };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async attempt(id: ExternalSearchSourceId, query: string): Promise<SearchResultItem[]> {
    try {
      const results = await this.request(id, query);
      this.readiness.delete(id);
      return results;
    } catch (error) {
      const reason = error instanceof ExternalSearchError ? error.reason : 'network_error';
      this.record(id, false, reason);
      throw error;
    }
  }

  private record(source: ExternalSearchSourceId, ready: boolean, reason?: SearchSourceFailureReason): SearchSourceReadiness {
    const value = { source, ready, reason, checkedAt: this.now };
    this.readiness.set(source, value);
    return value;
  }

  private async request(id: ExternalSearchSourceId, query: string): Promise<SearchResultItem[]> {
    const key = this.key(id);
    if (!key) throw new ExternalSearchError(id, 'no_credential', `${this.source(id).label} 搜索凭据未配置`);
    const zhipu = id === 'zhipu';
    const endpoint = zhipu ? 'https://open.bigmodel.cn/api/paas/v4/web_search' : 'https://api.minimaxi.com/v1/coding_plan/search';
    let response: Response;
    try {
      response = await this.fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(zhipu
          ? { search_engine: 'search_pro_sogou', search_query: query, count: 10 }
          : { q: query }),
      });
    } catch (error) {
      throw new ExternalSearchError(id, 'network_error', error instanceof Error ? error.message : '网络请求失败');
    }
    const raw = await response.text();
    if (!response.ok) throw new ExternalSearchError(id, failureReason(response.status, raw), `HTTP ${response.status}`);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { throw new ExternalSearchError(id, 'network_error', '搜索服务返回了无效 JSON'); }
    const apiError = body.error;
    if (apiError) {
      const detail = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);
      throw new ExternalSearchError(id, failureReason(undefined, detail), detail);
    }
    if (!zhipu) {
      const base = body.base_resp as { status_code?: number; status_msg?: string } | undefined;
      if (base?.status_code !== 0) throw new ExternalSearchError(id, failureReason(undefined, `${base?.status_code} ${base?.status_msg}`), base?.status_msg || 'MiniMax 搜索失败');
      return ((body.organic as Array<Record<string, unknown>> | undefined) ?? []).map((item) => ({ title: String(item.title ?? ''), url: String(item.link ?? ''), snippet: typeof item.snippet === 'string' ? item.snippet : undefined, date: typeof item.date === 'string' ? item.date : undefined, source: id })).filter((item) => item.title && item.url);
    }
    return ((body.search_result as Array<Record<string, unknown>> | undefined) ?? []).map((item) => ({ title: String(item.title ?? ''), url: String(item.link ?? ''), snippet: typeof item.content === 'string' ? item.content : undefined, date: typeof item.publish_date === 'string' ? item.publish_date : undefined, source: id })).filter((item) => item.title && item.url);
  }
}
