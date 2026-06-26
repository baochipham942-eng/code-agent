// ============================================================================
// 前端热更：缓存目录解析 + active 健康校验（读取侧）
// ============================================================================
// serve 路径决策：active 健康（合法 meta + index.html 存在）→ serve 云端版；
// 否则一律 fallback 包内 builtin。写入/原子切换（rename pending→active）在编排层。
// 兜底铁律：meta 缺失/畸形/缺字段、index.html 缺失 → 视为不健康，回包内基线。

import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RendererBundleLastAttemptStatus,
  RendererBundleSourceStatus,
  RendererBundleStatus,
} from '../../../shared/contract/update';
import type {
  RendererServeDecision,
  RendererServeDecisionReason,
} from '../../../shared/contract/desktopShell';
import {
  RENDERER_BUNDLE_CHANNEL_ENV,
  RENDERER_BUNDLE_MANIFEST_URL_ENV,
  RendererBundleEndpointError,
  resolveRendererBundleEndpoint,
} from '../../../shared/constants/network';
import { compareUpdateVersions } from '../cloud/updateService';

export const RENDERER_HOT_UPDATE_DISABLE_ENV = 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE';
export const RENDERER_BUNDLE_DISABLED_ENV = 'CODE_AGENT_RENDERER_BUNDLE_DISABLED';

function parseBooleanEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

export function getRendererHotUpdateDisabledReason(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (parseBooleanEnv(env[RENDERER_HOT_UPDATE_DISABLE_ENV])) return RENDERER_HOT_UPDATE_DISABLE_ENV;
  if (parseBooleanEnv(env[RENDERER_BUNDLE_DISABLED_ENV])) return RENDERER_BUNDLE_DISABLED_ENV;
  return null;
}

export function isRendererHotUpdateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRendererHotUpdateDisabledReason(env) !== null;
}

export function rendererCacheDir(dataDir: string): string {
  return join(dataDir, 'renderer-cache');
}

export function activeBundleDir(dataDir: string): string {
  return join(rendererCacheDir(dataDir), 'active');
}

export function pendingBundleDir(dataDir: string): string {
  return join(rendererCacheDir(dataDir), 'pending');
}

export function rendererBundleStatusPath(dataDir: string): string {
  return join(rendererCacheDir(dataDir), 'last-status.json');
}

export interface ActiveBundleMeta {
  version: string;
  contentHash: string;
}

export interface ResolveRendererServeDirOptions {
  currentShellVersion?: string;
}

type ActiveBundleMetaReadResult =
  | { status: 'missing'; meta: null }
  | { status: 'invalid'; meta: null }
  | { status: 'valid'; meta: ActiveBundleMeta };

function isValidMeta(value: unknown): value is ActiveBundleMeta {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.version === 'string' && m.version.length > 0 &&
    typeof m.contentHash === 'string' && m.contentHash.length > 0
  );
}

export function readActiveBundleMeta(dataDir: string): ActiveBundleMeta | null {
  const result = readActiveBundleMetaWithStatus(dataDir);
  return result.status === 'valid' ? result.meta : null;
}

function readActiveBundleMetaWithStatus(dataDir: string): ActiveBundleMetaReadResult {
  const metaPath = join(activeBundleDir(dataDir), '.bundle-meta.json');
  if (!existsSync(metaPath)) {
    return { status: 'missing', meta: null };
  }
  try {
    const raw = readFileSync(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isValidMeta(parsed)
      ? { status: 'valid', meta: { version: parsed.version, contentHash: parsed.contentHash } }
      : { status: 'invalid', meta: null };
  } catch {
    return { status: 'invalid', meta: null };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isValidLastAttempt(value: unknown): value is RendererBundleLastAttemptStatus {
  if (!value || typeof value !== 'object') return false;
  const attempt = value as Record<string, unknown>;
  const manifest = attempt.manifest as Record<string, unknown> | undefined;
  const rollout = attempt.rollout as Record<string, unknown> | undefined;
  const runtimeAssetPreparation = attempt.runtimeAssetPreparation as Record<string, unknown> | undefined;
  return (
    typeof attempt.checkedAt === 'string' &&
    typeof attempt.manifestUrl === 'string' &&
    typeof attempt.currentShellVersion === 'string' &&
    (
      attempt.outcome === 'applied' ||
      attempt.outcome === 'rolled-back' ||
      attempt.outcome === 'skipped' ||
      attempt.outcome === 'failed'
    ) &&
    (attempt.reason === undefined || typeof attempt.reason === 'string') &&
    (
      manifest === undefined ||
      (
        typeof manifest.version === 'string' &&
        typeof manifest.minShellVersion === 'string' &&
        typeof manifest.requiredShellCapabilitiesCount === 'number' &&
        (manifest.requiredRuntimeAssetsCount === undefined || typeof manifest.requiredRuntimeAssetsCount === 'number') &&
        (manifest.requiredResourcesCount === undefined || typeof manifest.requiredResourcesCount === 'number') &&
        (manifest.contentHash === undefined || typeof manifest.contentHash === 'string') &&
        (manifest.bundleUrl === undefined || typeof manifest.bundleUrl === 'string') &&
        (manifest.rollbackToBuiltin === undefined || typeof manifest.rollbackToBuiltin === 'boolean') &&
        (manifest.rollbackReason === undefined || typeof manifest.rollbackReason === 'string')
      )
    ) &&
    (
      runtimeAssetPreparation === undefined ||
      (
        runtimeAssetPreparation.attempted === true &&
        Array.isArray(runtimeAssetPreparation.installed) &&
        runtimeAssetPreparation.installed.every((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const candidate = entry as Record<string, unknown>;
          return (
            typeof candidate.assetId === 'string' &&
            (
              candidate.reusedExistingInstall === undefined ||
              typeof candidate.reusedExistingInstall === 'boolean'
            )
          );
        }) &&
        Array.isArray(runtimeAssetPreparation.skipped) &&
        runtimeAssetPreparation.skipped.every((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const candidate = entry as Record<string, unknown>;
          return typeof candidate.assetId === 'string' && typeof candidate.reason === 'string';
        }) &&
        (
          runtimeAssetPreparation.errorMessage === undefined ||
          typeof runtimeAssetPreparation.errorMessage === 'string'
        )
      )
    ) &&
    (
      rollout === undefined ||
      (
        typeof rollout.policyUrl === 'string' &&
        (
          rollout.decision === 'use-manifest' ||
          rollout.decision === 'rollback-to-builtin' ||
          rollout.decision === 'skip' ||
          rollout.decision === 'unavailable' ||
          rollout.decision === 'untrusted'
        ) &&
        (rollout.policyVersion === undefined || typeof rollout.policyVersion === 'string') &&
        (rollout.rolloutApplied === undefined || typeof rollout.rolloutApplied === 'boolean') &&
        (rollout.rolloutBucket === undefined || typeof rollout.rolloutBucket === 'number') &&
        (rollout.rolloutPercent === undefined || typeof rollout.rolloutPercent === 'number') &&
        (rollout.fallbackReason === undefined || typeof rollout.fallbackReason === 'string') &&
        (rollout.reason === undefined || typeof rollout.reason === 'string') &&
        (rollout.rollbackReason === undefined || typeof rollout.rollbackReason === 'string') &&
        (rollout.diagnostics === undefined || isStringArray(rollout.diagnostics)) &&
        (rollout.errorMessage === undefined || typeof rollout.errorMessage === 'string')
      )
    ) &&
    (attempt.diagnostics === undefined || isStringArray(attempt.diagnostics)) &&
    (attempt.missingShellCapabilities === undefined || isStringArray(attempt.missingShellCapabilities)) &&
    (attempt.missingRuntimeAssets === undefined || isStringArray(attempt.missingRuntimeAssets)) &&
    (attempt.missingResources === undefined || isStringArray(attempt.missingResources)) &&
    (attempt.errorMessage === undefined || typeof attempt.errorMessage === 'string')
  );
}

function resolveRendererBundleSourceStatus(env: NodeJS.ProcessEnv = process.env): RendererBundleSourceStatus {
  try {
    return resolveRendererBundleEndpoint(env);
  } catch (err) {
    if (err instanceof RendererBundleEndpointError) {
      return {
        channel: env[RENDERER_BUNDLE_CHANNEL_ENV]?.trim() || 'latest',
        ...(env[RENDERER_BUNDLE_MANIFEST_URL_ENV]?.trim() ? { manifestUrlOverride: true } : {}),
        errorReason: err.code,
        errorMessage: err.message,
        errorTarget: err.target,
      };
    }
    return {
      channel: env[RENDERER_BUNDLE_CHANNEL_ENV]?.trim() || 'latest',
      errorReason: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function rendererBundleStatusEnvelope(
  dataDir: string,
  lastAttempt: RendererBundleLastAttemptStatus | null,
  env: NodeJS.ProcessEnv = process.env,
): RendererBundleStatus {
  const disabledReason = getRendererHotUpdateDisabledReason(env);
  return {
    schemaVersion: 1,
    ...(disabledReason ? { disabled: true, disabledReason } : {}),
    source: resolveRendererBundleSourceStatus(env),
    activeBundle: disabledReason ? null : readActiveBundleMeta(dataDir),
    lastAttempt,
  };
}

export function readRendererBundleStatus(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RendererBundleStatus {
  try {
    const raw = readFileSync(rendererBundleStatusPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lastAttempt = isValidLastAttempt(parsed.lastAttempt) ? parsed.lastAttempt : null;
    return rendererBundleStatusEnvelope(dataDir, lastAttempt, env);
  } catch {
    return rendererBundleStatusEnvelope(dataDir, null, env);
  }
}

export async function writeRendererBundleLastAttempt(
  dataDir: string,
  lastAttempt: RendererBundleLastAttemptStatus,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RendererBundleStatus> {
  await fs.mkdir(rendererCacheDir(dataDir), { recursive: true });
  const status = rendererBundleStatusEnvelope(dataDir, lastAttempt, env);
  await fs.writeFile(rendererBundleStatusPath(dataDir), JSON.stringify(status, null, 2), 'utf8');
  return status;
}

export async function clearRendererBundleActive(dataDir: string): Promise<void> {
  await fs.rm(activeBundleDir(dataDir), { recursive: true, force: true });
  await fs.rm(pendingBundleDir(dataDir), { recursive: true, force: true });
}

/** 喂给契约门 BundleApplyContext.activeContentHash */
export function readActiveContentHash(dataDir: string): string | null {
  return readActiveBundleMeta(dataDir)?.contentHash ?? null;
}

/** serve 目录决策：active 健康 → active 绝对路径；否则包内 builtin */
export function resolveRendererServeDecision(
  dataDir: string,
  builtinDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRendererServeDirOptions = {},
): RendererServeDecision {
  const active = activeBundleDir(dataDir);
  const baseDecision = (
    reason: RendererServeDecisionReason,
    extra: Partial<RendererServeDecision> = {},
  ): RendererServeDecision => ({
    source: reason === 'active-healthy' ? 'active' : 'builtin',
    reason,
    serveDir: reason === 'active-healthy' ? active : builtinDir,
    builtinDir,
    activeDir: active,
    activeBundle: null,
    ...(options.currentShellVersion ? { currentShellVersion: options.currentShellVersion } : {}),
    ...extra,
  });

  const disabledReason = getRendererHotUpdateDisabledReason(env);
  if (disabledReason) {
    return baseDecision('hot-update-disabled', { disabledReason });
  }

  const activeMetaResult = readActiveBundleMetaWithStatus(dataDir);
  if (activeMetaResult.status === 'missing') {
    return baseDecision('no-active-meta');
  }
  if (activeMetaResult.status === 'invalid') {
    return baseDecision('invalid-active-meta');
  }

  const activeMeta = activeMetaResult.meta;
  const activeIsOlderThanShell = options.currentShellVersion
    ? compareUpdateVersions(activeMeta.version, options.currentShellVersion) < 0
    : false;
  if (activeIsOlderThanShell) {
    return baseDecision('active-older-than-shell', { activeBundle: activeMeta });
  }
  if (!existsSync(join(active, 'index.html'))) {
    return baseDecision('active-index-missing', { activeBundle: activeMeta });
  }

  return baseDecision('active-healthy', { activeBundle: activeMeta });
}

export function resolveRendererServeDir(
  dataDir: string,
  builtinDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRendererServeDirOptions = {},
): string {
  return resolveRendererServeDecision(dataDir, builtinDir, env, options).serveDir;
}
