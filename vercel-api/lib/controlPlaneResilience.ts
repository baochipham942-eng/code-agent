import * as crypto from 'node:crypto';

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_STALE_TTL_MS = 300_000;
const DEFAULT_CIRCUIT_OPEN_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 2_500;
const MAX_CACHE_ENTRIES = 1_000;

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  staleUntilMs: number;
}

interface CircuitEntry {
  openUntilMs: number;
  failures: number;
}

export interface CachedControlPlaneValue<T> {
  hit: boolean;
  stale: boolean;
  value: T | undefined;
}

export interface ControlPlaneFetchOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  circuitOpenMs?: number;
  nowMs?: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const circuits = new Map<string, CircuitEntry>();

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readPositiveNumberEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  fallback: number,
): number {
  const raw = readEnv(env, names);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) {
      return;
    }
    cache.delete(oldest);
  }
}

export function makeControlPlaneCacheKey(kind: string, parts: Array<string | null | undefined>): string {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => part ?? '').join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${kind}:${digest}`;
}

export function readControlPlaneCacheTtlMs(env: NodeJS.ProcessEnv): number {
  return readPositiveNumberEnv(env, [
    'CONTROL_PLANE_SUPABASE_CACHE_TTL_MS',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_CACHE_TTL_MS',
  ], DEFAULT_CACHE_TTL_MS);
}

export function readControlPlaneStaleTtlMs(env: NodeJS.ProcessEnv): number {
  return readPositiveNumberEnv(env, [
    'CONTROL_PLANE_SUPABASE_STALE_TTL_MS',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_STALE_TTL_MS',
  ], DEFAULT_STALE_TTL_MS);
}

export function readControlPlaneCircuitOpenMs(env: NodeJS.ProcessEnv): number {
  return readPositiveNumberEnv(env, [
    'CONTROL_PLANE_SUPABASE_CIRCUIT_OPEN_MS',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_CIRCUIT_OPEN_MS',
  ], DEFAULT_CIRCUIT_OPEN_MS);
}

export function readControlPlaneFetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveNumberEnv(env, [
    'CONTROL_PLANE_SUPABASE_FETCH_TIMEOUT_MS',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_FETCH_TIMEOUT_MS',
  ], DEFAULT_FETCH_TIMEOUT_MS);
}

export function readCachedControlPlaneValue<T>(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { allowStale?: boolean; nowMs?: number } = {},
): CachedControlPlaneValue<T> {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    return { hit: false, stale: false, value: undefined };
  }
  const nowMs = options.nowMs ?? Date.now();
  if (entry.expiresAtMs >= nowMs) {
    return { hit: true, stale: false, value: entry.value };
  }
  if (options.allowStale && entry.staleUntilMs >= nowMs) {
    return { hit: true, stale: true, value: entry.value };
  }
  if (entry.staleUntilMs < nowMs) {
    cache.delete(key);
  }
  return { hit: false, stale: false, value: undefined };
}

export function writeControlPlaneCacheValue<T>(
  key: string,
  value: T,
  env: NodeJS.ProcessEnv = process.env,
  options: { ttlMs?: number; staleTtlMs?: number; nowMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? readControlPlaneCacheTtlMs(env);
  const staleTtlMs = options.staleTtlMs ?? readControlPlaneStaleTtlMs(env);
  cache.set(key, {
    value,
    expiresAtMs: nowMs + ttlMs,
    staleUntilMs: nowMs + ttlMs + staleTtlMs,
  });
  trimCache();
}

export function isTransientControlPlaneStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isControlPlaneCircuitOpen(
  key: string,
  options: { nowMs?: number } = {},
): boolean {
  const circuit = circuits.get(key);
  if (!circuit) {
    return false;
  }
  const nowMs = options.nowMs ?? Date.now();
  if (circuit.openUntilMs > nowMs) {
    return true;
  }
  circuits.delete(key);
  return false;
}

export function markControlPlaneCircuitFailure(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { circuitOpenMs?: number; nowMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const circuitOpenMs = options.circuitOpenMs ?? readControlPlaneCircuitOpenMs(env);
  circuits.set(key, {
    failures: (circuits.get(key)?.failures ?? 0) + 1,
    openUntilMs: nowMs + circuitOpenMs,
  });
}

export function markControlPlaneCircuitSuccess(key: string): void {
  circuits.delete(key);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) {
    return fetchImpl(input, init);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchControlPlaneResource(
  key: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  options: ControlPlaneFetchOptions = {},
): Promise<Response | null> {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  if (isControlPlaneCircuitOpen(key, { nowMs })) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      input,
      init,
      options.timeoutMs ?? readControlPlaneFetchTimeoutMs(env),
    );
    if (isTransientControlPlaneStatus(response.status)) {
      markControlPlaneCircuitFailure(key, env, {
        circuitOpenMs: options.circuitOpenMs,
        nowMs,
      });
    } else if (response.ok) {
      markControlPlaneCircuitSuccess(key);
    }
    return response;
  } catch {
    markControlPlaneCircuitFailure(key, env, {
      circuitOpenMs: options.circuitOpenMs,
      nowMs,
    });
    return null;
  }
}

export function resetControlPlaneResilienceForTests(): void {
  cache.clear();
  circuits.clear();
}
