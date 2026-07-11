// ============================================================================
// Tool Cache - 工具结果缓存（短期记忆）
// ============================================================================

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { getDatabase } from '../core';
import type { ToolResult } from '../../../shared/contract';
import { createLogger } from './logger';

import { Disposable, getServiceRegistry } from '../serviceRegistry';
const logger = createLogger('ToolCache');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ToolCacheScope {
  sessionId?: string;
  workingDirectory?: string;
  /** Hash-bound MCP/local provider identity. Defaults to the explicit local sentinel. */
  serverIdentity?: string;
  /** Capability/trust policy revision used for this invocation. */
  capabilityPolicyVersion?: string;
  /** Version/fingerprint of external data not otherwise represented by normalized args. */
  dataFingerprint?: string;
}

export interface NormalizedToolCacheScope {
  sessionId: string;
  workspaceIdentity: string;
  cacheNamespace: string;
  memoryScopeKey: string;
}

export interface CacheEntry {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  scopeKey: string;
  referencedPaths: string[];
  createdAt: number;
  expiresAt: number | null;
  hitCount: number;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
}

export interface ToolCacheConfig {
  defaultTTL: number;
  maxMemoryEntries: number;
  persistentCache: boolean;
  /** Explicit, proof-bearing allowlist. Production keeps this empty. */
  policies: Readonly<Record<string, ToolCachePolicy>>;
  now: () => number;
}

export interface ToolCachePolicyEvidence {
  pureRead: boolean;
  noHiddenLifecycleSideEffects: boolean;
  noContextEvidenceMutation: boolean;
  externalChangesCoveredByKey: boolean;
  replaySafe: boolean;
}

export interface ToolCachePolicy {
  toolVersion: string;
  policyVersion: string;
  /** A positive TTL supplies the key's TTL bucket when no data fingerprint is present. */
  ttlMs: number;
  evidence: ToolCachePolicyEvidence;
}

const CACHE_NAMESPACE_VERSION = 'tool-cache:v3';

/**
 * Cache admission is exact and fail-closed. No currently registered protocol
 * tool is semantically pure enough to skip its handler lifecycle safely:
 * even Read updates file-read evidence and context-health state. Additions must
 * therefore be explicit and backed by lifecycle + invalidation tests.
 */
export const TOOL_CACHE_ALLOWLIST: Readonly<Record<string, ToolCachePolicy>> = Object.freeze({});

const PATH_ARGUMENT_KEYS = [
  'file_path',
  'path',
  'directory',
  'working_directory',
  'target_path',
  'targetPath',
  'output_path',
  'outputPath',
];

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string | null {
  try {
    return JSON.stringify(canonicalizeJson(value));
  } catch {
    return null;
  }
}

export function normalizeToolCacheScope(
  scope: ToolCacheScope | undefined,
): NormalizedToolCacheScope | null {
  const sessionId = scope?.sessionId?.trim();
  const workingDirectory = scope?.workingDirectory?.trim();
  if (!sessionId || !workingDirectory) return null;

  try {
    const workspaceIdentity = realpathSync.native(nodePath.resolve(workingDirectory));
    const workspaceHash = createHash('sha256').update(workspaceIdentity).digest('hex');
    const cacheNamespace = `${CACHE_NAMESPACE_VERSION}:${workspaceHash}`;
    return {
      sessionId,
      workspaceIdentity,
      cacheNamespace,
      memoryScopeKey: `${sessionId}:${cacheNamespace}`,
    };
  } catch {
    // A workspace that cannot be identified canonically must never share cache.
    return null;
  }
}

function normalizeReferencedPath(
  rawPath: string,
  workspaceIdentity: string,
): string {
  const expanded = rawPath.startsWith('~/')
    ? nodePath.join(homedir(), rawPath.slice(2))
    : rawPath;
  const absolute = nodePath.isAbsolute(expanded)
    ? nodePath.normalize(expanded)
    : nodePath.resolve(workspaceIdentity, expanded);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function collectReferencedPaths(
  args: Record<string, unknown>,
  scope: NormalizedToolCacheScope,
): string[] {
  const paths = PATH_ARGUMENT_KEYS
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeReferencedPath(value, scope.workspaceIdentity));
  return [...new Set(paths)];
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftRelative = nodePath.relative(left, right);
  if (leftRelative && !leftRelative.startsWith('..') && !nodePath.isAbsolute(leftRelative)) return true;
  const rightRelative = nodePath.relative(right, left);
  return Boolean(rightRelative) && !rightRelative.startsWith('..') && !nodePath.isAbsolute(rightRelative);
}

function isProvenPolicy(policy: ToolCachePolicy): boolean {
  return Boolean(
    policy.toolVersion.trim()
    && policy.policyVersion.trim()
    && Number.isFinite(policy.ttlMs)
    && policy.ttlMs > 0
    && policy.evidence.pureRead === true
    && policy.evidence.noHiddenLifecycleSideEffects === true
    && policy.evidence.noContextEvidenceMutation === true
    && policy.evidence.externalChangesCoveredByKey === true
    && policy.evidence.replaySafe === true,
  );
}

function persistentNamespace(memoryKey: string): string {
  return `${CACHE_NAMESPACE_VERSION}:${createHash('sha256').update(memoryKey).digest('hex')}`;
}

// ----------------------------------------------------------------------------
// Tool Cache Service
// ----------------------------------------------------------------------------

export class ToolCache implements Disposable {
  private config: ToolCacheConfig;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private stats: { hits: number; misses: number } = { hits: 0, misses: 0 };
  private _dbErrorLogged = false;

  constructor(config?: Partial<ToolCacheConfig>) {
    this.config = {
      defaultTTL: 5 * 60 * 1000,
      maxMemoryEntries: 100,
      persistentCache: true,
      policies: TOOL_CACHE_ALLOWLIST,
      now: Date.now,
      ...config,
    };
  }

  /**
   * Kept for the existing session lifecycle caller. Cache identity no longer
   * reads mutable singleton session state; every get/set receives its own scope.
   */
  setSessionId(sessionId: string): void {
    void sessionId;
  }

  private generateKey(
    toolName: string,
    args: Record<string, unknown>,
    scope: NormalizedToolCacheScope,
    rawScope: ToolCacheScope,
    policy: ToolCachePolicy,
  ): string | null {
    const serializedArgs = stableStringify(args);
    if (serializedArgs === null) return null;
    if (
      /^mcp(__|_)/i.test(toolName)
      && (!rawScope.serverIdentity?.trim() || !rawScope.capabilityPolicyVersion?.trim())
    ) return null;
    const ttl = policy.ttlMs || this.config.defaultTTL;
    const dataVersion = rawScope.dataFingerprint?.trim()
      ? `fingerprint:${rawScope.dataFingerprint.trim()}`
      : ttl > 0 ? `ttl-bucket:${Math.floor(this.config.now() / ttl)}` : null;
    if (!dataVersion) return null;
    const dimensions = stableStringify({
      namespace: CACHE_NAMESPACE_VERSION,
      toolName,
      toolVersion: policy.toolVersion,
      normalizedArgs: canonicalizeJson(args),
      workspaceFingerprint: scope.cacheNamespace,
      sessionScope: scope.sessionId,
      serverIdentity: rawScope.serverIdentity?.trim() || 'local',
      capabilityPolicyVersion: rawScope.capabilityPolicyVersion?.trim() || policy.policyVersion,
      cachePolicyVersion: policy.policyVersion,
      dataVersion,
    });
    if (dimensions === null) return null;
    return `${scope.memoryScopeKey}:${createHash('sha256').update(dimensions).digest('hex')}`;
  }

  isCacheable(toolName: string, _untrustedHints?: unknown): boolean {
    const policy = this.config.policies[toolName];
    return policy !== undefined && isProvenPolicy(policy);
  }

  getTTL(toolName: string): number {
    const policy = this.config.policies[toolName];
    if (!policy || !isProvenPolicy(policy)) return 0;
    return policy.ttlMs || this.config.defaultTTL;
  }

  get(
    toolName: string,
    args: Record<string, unknown>,
    rawScope?: ToolCacheScope,
  ): ToolResult | null {
    if (!this.isCacheable(toolName)) return null;

    const scope = normalizeToolCacheScope(rawScope);
    const policy = this.config.policies[toolName];
    if (!scope) {
      this.stats.misses++;
      return null;
    }
    if (!policy || !isProvenPolicy(policy)) return null;
    const key = this.generateKey(toolName, args, scope, rawScope ?? {}, policy);
    if (!key) {
      this.stats.misses++;
      return null;
    }
    const now = this.config.now();

    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      if (memoryEntry.expiresAt === null || memoryEntry.expiresAt > now) {
        memoryEntry.hitCount++;
        this.stats.hits++;
        return memoryEntry.result;
      }
      this.memoryCache.delete(key);
    }

    if (this.config.persistentCache) {
      try {
        const dbResult = getDatabase().getCachedToolResult(
          scope.sessionId,
          persistentNamespace(key),
          toolName,
          args,
        );
        if (dbResult) {
          this.setMemoryCache(key, {
            toolName,
            args,
            result: dbResult,
            scopeKey: scope.memoryScopeKey,
            referencedPaths: collectReferencedPaths(args, scope),
            createdAt: now,
            expiresAt: now + this.getTTL(toolName),
            hitCount: 1,
          });
          this.stats.hits++;
          return dbResult;
        }
      } catch (error) {
        this.logDbError(error);
      }
    }

    this.stats.misses++;
    return null;
  }

  set(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    rawScope?: ToolCacheScope,
    customTTL?: number,
  ): void {
    if (!this.isCacheable(toolName) || !result.success) return;

    const scope = normalizeToolCacheScope(rawScope);
    const policy = this.config.policies[toolName];
    if (!scope) return;
    if (!policy || !isProvenPolicy(policy)) return;
    const key = this.generateKey(toolName, args, scope, rawScope ?? {}, policy);
    if (!key) return;

    const now = this.config.now();
    const ttl = customTTL ?? this.getTTL(toolName);
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    const expiresAt = now + ttl;
    this.setMemoryCache(key, {
      toolName,
      args,
      result,
      scopeKey: scope.memoryScopeKey,
      referencedPaths: collectReferencedPaths(args, scope),
      createdAt: now,
      expiresAt,
      hitCount: 0,
    });

    if (this.config.persistentCache) {
      try {
        getDatabase().saveToolExecution(
          scope.sessionId,
          null,
          toolName,
          args,
          result,
          persistentNamespace(key),
          ttl,
        );
      } catch (error) {
        this.logDbError(error);
      }
    }
  }

  private setMemoryCache(key: string, entry: CacheEntry): void {
    if (this.memoryCache.size >= this.config.maxMemoryEntries) {
      let minHitKey: string | null = null;
      let minHitCount = Infinity;
      for (const [candidateKey, candidate] of this.memoryCache.entries()) {
        if (candidate.hitCount < minHitCount) {
          minHitCount = candidate.hitCount;
          minHitKey = candidateKey;
        }
      }
      if (minHitKey) this.memoryCache.delete(minHitKey);
    }
    this.memoryCache.set(key, entry);
  }

  invalidate(
    toolName: string,
    args?: Record<string, unknown>,
    rawScope?: ToolCacheScope,
  ): void {
    const scope = normalizeToolCacheScope(rawScope);
    if (!scope) return;

    if (args) {
      const policy = this.config.policies[toolName];
      if (!policy || !isProvenPolicy(policy)) return;
      const key = this.generateKey(toolName, args, scope, rawScope ?? {}, policy);
      if (key) this.memoryCache.delete(key);
      return;
    }
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.scopeKey === scope.memoryScopeKey && entry.toolName === toolName) {
        this.memoryCache.delete(key);
      }
    }
  }

  invalidateForPath(filePath: string, rawScope?: ToolCacheScope): void {
    const scope = normalizeToolCacheScope(rawScope);
    if (!scope) return;
    const normalizedPath = normalizeReferencedPath(filePath, scope.workspaceIdentity);
    for (const [key, entry] of this.memoryCache.entries()) {
      if (
        entry.scopeKey === scope.memoryScopeKey
        && entry.referencedPaths.some((referencedPath) => pathsOverlap(referencedPath, normalizedPath))
      ) {
        this.memoryCache.delete(key);
      }
    }
    this.invalidatePersistentSession(scope.sessionId);
  }

  invalidateForWorkspace(rawScope?: ToolCacheScope): void {
    const scope = normalizeToolCacheScope(rawScope);
    if (!scope) return;
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.scopeKey === scope.memoryScopeKey) this.memoryCache.delete(key);
    }
    this.invalidatePersistentSession(scope.sessionId);
  }

  private invalidatePersistentSession(sessionId: string): void {
    if (!this.config.persistentCache) return;
    try {
      getDatabase().invalidateCachedToolResults(sessionId);
    } catch (error) {
      this.logDbError(error);
    }
  }

  private logDbError(error: unknown): void {
    if (this._dbErrorLogged) return;
    this._dbErrorLogged = true;
    logger.warn('DB cache unavailable, using memory-only cache:', (error as Error).message);
  }

  clear(): void {
    this.memoryCache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  cleanExpired(): number {
    const now = this.config.now();
    let cleaned = 0;
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }

    if (this.config.persistentCache) {
      try {
        cleaned += getDatabase().cleanExpiredCache();
      } catch {
        // DB unavailable: memory cleanup still succeeded.
      }
    }
    return cleaned;
  }

  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      totalEntries: this.memoryCache.size,
      hitCount: this.stats.hits,
      missCount: this.stats.misses,
      hitRate: totalRequests > 0 ? this.stats.hits / totalRequests : 0,
    };
  }

  async dispose(): Promise<void> {
    this.clear();
    this.resetStats();
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0 };
  }
}

let cacheInstance: ToolCache | null = null;

export function getToolCache(): ToolCache {
  if (!cacheInstance) cacheInstance = new ToolCache();
  return cacheInstance;
}

export function initToolCache(config?: Partial<ToolCacheConfig>): ToolCache {
  cacheInstance = new ToolCache(config);
  return cacheInstance;
}

getServiceRegistry().register('ToolCache', getToolCache());
