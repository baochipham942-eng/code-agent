import { createPublicKey, verify as verifySignature, type KeyObject, type webcrypto } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Supabase access token 的离线验签（N-COMPANION-RELAY-ACCOUNT-BIND）。
 *
 * relay 所在的上海机器到 supabase.co 常慢或不通，所以验签只读内存里的公钥，从不在握手里等网络：
 * - 启动先读落盘缓存，立刻可验；后台再拉 JWKS，成功就覆盖内存与磁盘。
 * - 每 refreshMs 拉一次；遇到未知 kid 本次照拒，并触发一次后台刷新（冷却期内不重复拉）。
 * - 最后一次成功拉取距今超过 maxStaleMs 就拒所有 JWT（共享凭据不经过这里，不受影响）。
 * 只认 ES256：Supabase 项目已切非对称签名，HS256 共享密钥不该出现在 relay 上。
 */

export interface AccountAuthLogger {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
}

export interface JwksStats {
  keys: number;
  fetchedAt: number | null;
  source: 'network' | 'disk' | 'none';
}

type Jwk = webcrypto.JsonWebKey & { kid: string };

interface CachedJwks {
  fetchedAt: number;
  keys: Jwk[];
}

const MAX_KEYS = 16;
const CLOCK_SKEW_S = 60;

function decodeSegment(segment: string): Buffer | null {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? Buffer.from(segment, 'base64url') : null;
}

function parseJson(buffer: Buffer | null): Record<string, unknown> | null {
  if (!buffer) return null;
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 只留 P-256 签名公钥；其余（RSA、对称、用途不符）静默忽略。 */
function usableKeys(raw: unknown): Jwk[] {
  const keys = raw && typeof raw === 'object' ? (raw as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) return [];
  return keys.filter((key): key is Jwk => {
    if (!key || typeof key !== 'object') return false;
    const k = key as Record<string, unknown>;
    return k.kty === 'EC' && k.crv === 'P-256' && typeof k.kid === 'string' && typeof k.x === 'string'
      && typeof k.y === 'string' && (k.alg === undefined || k.alg === 'ES256') && (k.use === undefined || k.use === 'sig');
  }).slice(0, MAX_KEYS);
}

export class SupabaseJwtVerifier {
  private keys = new Map<string, KeyObject>();
  /** 与 keys 同步的原始 JWK，只为落盘。 */
  private rawKeys: Jwk[] = [];
  private fetchedAt: number | null = null;
  private source: JwksStats['source'] = 'none';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastUnknownKidRefresh = -Infinity;
  private unusableLogged = false;
  private readonly issuer: string;
  private readonly jwksUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: {
    supabaseUrl: string;
    cacheFile?: string;
    fetch?: typeof fetch;
    now?: () => number;
    logger?: AccountAuthLogger;
    refreshMs?: number;
    maxStaleMs?: number;
    unknownKidCooldownMs?: number;
    fetchTimeoutMs?: number;
  }) {
    const base = options.supabaseUrl.replace(/\/+$/, '');
    this.issuer = `${base}/auth/v1`;
    this.jwksUrl = `${this.issuer}/.well-known/jwks.json`;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get stats(): JwksStats {
    return { keys: this.keys.size, fetchedAt: this.fetchedAt, source: this.source };
  }

  /** 读落盘缓存、起后台刷新。不等网络：返回时磁盘上有公钥就已经能验。 */
  start(): void {
    this.loadCache();
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.options.refreshMs ?? 6 * 60 * 60_000);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** 拉一次 JWKS；并发调用合并成同一次。失败保留原有公钥。 */
  refresh(): Promise<void> {
    this.inFlight ??= this.fetchOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** 通过返回 Supabase 用户 id（sub），任何一项不满足返回 null。同步，不碰网络。 */
  verify(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = parseJson(decodeSegment(parts[0]));
    const payload = parseJson(decodeSegment(parts[1]));
    const signature = decodeSegment(parts[2]);
    if (!header || !payload || !signature || header.alg !== 'ES256' || typeof header.kid !== 'string') return null;
    if (this.fetchedAt === null || this.now() - this.fetchedAt > (this.options.maxStaleMs ?? 30 * 24 * 60 * 60_000)) {
      // 每个令牌形状的连接都会走到这里：只在进入该状态时记一次，别让未鉴权的客户端刷日志。
      if (!this.unusableLogged) this.options.logger?.warn(this.fetchedAt === null ? 'jwks_unavailable' : 'jwks_stale', { fetchedAt: this.fetchedAt });
      this.unusableLogged = true;
      return null;
    }
    const key = this.keys.get(header.kid);
    if (!key) {
      this.refreshForUnknownKid();
      return null;
    }
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verifySignature('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)) return null;
    const nowS = this.now() / 1000;
    const aud = payload.aud;
    const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'));
    // Supabase 匿名登录签出的令牌 role 同为 authenticated，只多一个 is_anonymous：不算账号。
    if (payload.iss !== this.issuer || !audOk || payload.role !== 'authenticated' || payload.is_anonymous === true) return null;
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S <= nowS) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_SKEW_S > nowS)) return null;
    if (typeof payload.sub !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(payload.sub)) return null;
    return payload.sub;
  }

  private refreshForUnknownKid(): void {
    const now = this.now();
    if (now - this.lastUnknownKidRefresh < (this.options.unknownKidCooldownMs ?? 5 * 60_000)) return;
    this.lastUnknownKidRefresh = now;
    void this.refresh();
  }

  private install(keys: Jwk[], fetchedAt: number, source: JwksStats['source']): boolean {
    const next = new Map<string, KeyObject>();
    for (const jwk of keys) {
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch { /* 坏公钥跳过 */ }
    }
    if (next.size === 0) return false;
    this.keys = next;
    this.rawKeys = keys.filter(jwk => next.has(jwk.kid));
    this.fetchedAt = fetchedAt;
    this.source = source;
    this.unusableLogged = false;
    return true;
  }

  private loadCache(): void {
    if (!this.options.cacheFile) return;
    try {
      const cached = JSON.parse(readFileSync(this.options.cacheFile, 'utf8')) as Partial<CachedJwks>;
      if (typeof cached.fetchedAt === 'number' && this.install(usableKeys(cached), cached.fetchedAt, 'disk')) {
        this.options.logger?.info('jwks_loaded', { source: 'disk', keys: this.keys.size, fetchedAt: cached.fetchedAt });
      }
    } catch {
      // 首次启动没有缓存文件是常态，坏文件等下一次网络刷新覆盖。
    }
  }

  private async fetchOnce(): Promise<void> {
    const fetchedAt = this.now();
    try {
      const response = await this.fetchImpl(this.jwksUrl, { signal: AbortSignal.timeout(this.options.fetchTimeoutMs ?? 5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!this.install(usableKeys(await response.json() as unknown), fetchedAt, 'network')) throw new Error('NO_USABLE_KEYS');
      this.options.logger?.info('jwks_loaded', { source: 'network', keys: this.keys.size });
    } catch (error) {
      this.options.logger?.warn('jwks_fetch_failed', { error: error instanceof Error ? error.message : String(error), source: this.source });
      return;
    }
    if (!this.options.cacheFile) return;
    try {
      const tmp = `${this.options.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt, keys: this.rawKeys } satisfies CachedJwks), { mode: 0o600 });
      renameSync(tmp, this.options.cacheFile);
    } catch (error) {
      // 落盘失败不影响内存里已装好的公钥，只是下次重启要等网络。
      this.options.logger?.warn('jwks_cache_write_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
