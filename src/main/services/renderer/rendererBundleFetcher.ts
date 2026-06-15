// ============================================================================
// 前端热更：拉取器编排（控制面）
// ============================================================================
// 串起地基三件：契约门(rendererBundlePolicy) + 完整性(rendererBundleIntegrity)
// + 缓存切换(rendererBundleCache)，再叠加 controlPlaneTrust 验签。
//
// 流程：fetch 签名 manifest envelope → 验签(kind=renderer_bundle) → 契约门 →
//       下载 bundle.tar.gz 到 pending → sha256 完整性 → 解压 → 校验解压健康 →
//       原子 rename(pending→active) → 写 .bundle-meta.json。
//
// 兜底铁律：任何一步失败都返回 { applied:false }，绝不抛出、绝不破坏现有 active。
// 只有在「下载+完整性+解压健康」全部通过后才动 active 目录，失败时当前前端原样保留。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  formatControlPlaneDiagnostics,
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from '../cloud/controlPlaneTrust';
import {
  RENDERER_BUNDLE_COHORT_ENV,
  RendererBundleEndpointError,
  resolveRendererBundleEndpoint,
} from '../../../shared/constants/network';
import { shouldApplyRendererBundle, type RendererBundleManifest } from './rendererBundlePolicy';
import {
  decideRendererBundleRollout,
  type RendererBundleRolloutPolicy,
} from './rendererBundleRolloutPolicy';
import { verifyBundleIntegrity } from './rendererBundleIntegrity';
import { getRuntimeAssetsStatus } from '../../runtime/runtimeAssetStatus';
import { resolveExistingResource } from '../../runtime/runtimeAssetResolver';
import {
  activeBundleDir,
  pendingBundleDir,
  rendererCacheDir,
  readActiveContentHash,
  getRendererHotUpdateDisabledReason,
  clearRendererBundleActive,
  writeRendererBundleLastAttempt,
} from './rendererBundleCache';
import { getShellCapabilityIds } from '../../shellCapabilities';
import type {
  PrepareRuntimeAssetsResult,
  RendererBundleLastAttemptStatus,
  RendererBundleManifestStatus,
  RendererBundleRuntimeAssetPreparationStatus,
  RendererBundleRolloutAttemptStatus,
  RendererBundleStatus,
} from '../../../shared/contract/update';
import { recordRendererBundleTelemetryAttempt } from './rendererBundleTelemetry';

const execFileAsync = promisify(execFile);

export interface RendererBundleFetcherOptions {
  /** 数据目录（~/.code-agent） */
  dataDir: string;
  /** 当前壳（app）版本，喂契约门 */
  currentShellVersion: string;
  /** 签名 manifest URL，默认 OSS 常量 */
  manifestUrl?: string;
  /** 签名 rollout policy URL；配置后先验策略，再选择 manifest。 */
  rolloutPolicyUrl?: string | null;
  /** 灰度稳定分桶 seed；默认用 dataDir 派生，不上报。 */
  rolloutSeed?: string;
  /** 显式 cohort；默认读 CODE_AGENT_RENDERER_BUNDLE_COHORT。 */
  rolloutCohort?: string;
  /** 平台；默认 process.platform。 */
  platform?: string;
  /** 环境变量注入，测试/灰度可指定 CODE_AGENT_RENDERER_BUNDLE_CHANNEL。 */
  env?: NodeJS.ProcessEnv;
  /** 控制面公钥，默认从环境/文件读取 */
  publicKeys?: ControlPlanePublicKeys;
  /** envelope 过期判定基准时间（测试可注入） */
  now?: number;
  /** 拉取 JSON（默认真实 fetch），返回 envelope */
  fetchJson?: (url: string) => Promise<unknown>;
  /** 下载文件到本地路径（默认真实 fetch + stream） */
  downloadToFile?: (url: string, destPath: string) => Promise<void>;
  /** 解压 tar.gz（默认系统 tar） */
  extractArchive?: (archivePath: string, destDir: string) => Promise<void>;
  /** 日志（默认静默） */
  logger?: (message: string) => void;
  /** 生产 kill switch；默认读 CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE / CODE_AGENT_RENDERER_BUNDLE_DISABLED。 */
  disabledReason?: string | null;
  /** metadata-only 热更状态上报；失败不能影响热更决策。 */
  recordTelemetryAttempt?: (status: RendererBundleStatus) => void | Promise<void>;
  /** 本机依赖探测（测试/特殊运行时可注入）。 */
  resolveDependencyContext?: (manifest: RendererBundleManifest) => Promise<RendererBundleDependencyContext>;
  /** 缺 runtime asset 时是否尝试自动预备并重跑契约门。 */
  autoPrepareRuntimeAssets?: boolean;
  /** runtime asset 预备入口；默认仅在 UpdateService 已初始化时调用。 */
  prepareRuntimeAssets?: (
    missingAssets: readonly string[],
    manifest: RendererBundleManifest,
  ) => Promise<PrepareRuntimeAssetsResult>;
}

export interface RendererBundleDependencyContext {
  availableRuntimeAssets?: readonly string[];
  availableResources?: readonly string[];
}

export type RendererBundleApplyResult =
  | { applied: true; version: string; contentHash: string }
  | { applied: false; reason: string };

function summarizeManifest(manifest: unknown): RendererBundleManifestStatus | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const candidate = manifest as Record<string, unknown>;
  if (
    typeof candidate.version !== 'string' ||
    candidate.version.length === 0 ||
    typeof candidate.minShellVersion !== 'string' ||
    candidate.minShellVersion.length === 0
  ) {
    return null;
  }
  const requiredShellCapabilities = candidate.requiredShellCapabilities;
  const requiredRuntimeAssets = candidate.requiredRuntimeAssets;
  const requiredResources = candidate.requiredResources;
  return {
    version: candidate.version,
    ...(typeof candidate.contentHash === 'string' && candidate.contentHash.length > 0
      ? { contentHash: candidate.contentHash }
      : {}),
    minShellVersion: candidate.minShellVersion,
    ...(typeof candidate.bundleUrl === 'string' && candidate.bundleUrl.length > 0
      ? { bundleUrl: candidate.bundleUrl }
      : {}),
    requiredShellCapabilitiesCount: Array.isArray(requiredShellCapabilities)
      ? requiredShellCapabilities.filter((entry) => typeof entry === 'string' && entry.length > 0).length
      : 0,
    requiredRuntimeAssetsCount: Array.isArray(requiredRuntimeAssets)
      ? requiredRuntimeAssets.filter((entry) => typeof entry === 'string' && entry.length > 0).length
      : 0,
    requiredResourcesCount: Array.isArray(requiredResources)
      ? requiredResources.filter((entry) => typeof entry === 'string' && entry.length > 0).length
      : 0,
    ...(candidate.rollbackToBuiltin === true ? { rollbackToBuiltin: true } : {}),
    ...(typeof candidate.rollbackReason === 'string' ? { rollbackReason: candidate.rollbackReason } : {}),
  };
}

function manifestStatusPatch(manifest: unknown): { manifest?: RendererBundleManifestStatus } {
  const summary = summarizeManifest(manifest);
  return summary ? { manifest: summary } : {};
}

function outcomeForPolicySkip(reason: string): 'skipped' | 'failed' {
  return reason === 'already-current' ||
    reason === 'shell-too-old' ||
    reason === 'missing-shell-capability' ||
    reason === 'missing-runtime-asset' ||
    reason === 'missing-resource'
    ? 'skipped'
    : 'failed';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0))];
}

function buildDefaultRolloutSeed(dataDir: string): string {
  return createHash('sha256').update(dataDir).digest('hex');
}

function summarizeRuntimeAssetPreparation(
  result: PrepareRuntimeAssetsResult,
): RendererBundleRuntimeAssetPreparationStatus {
  return {
    attempted: true,
    installed: result.installed.map((entry) => ({
      assetId: entry.assetId,
      ...(entry.reusedExistingInstall ? { reusedExistingInstall: true } : {}),
    })),
    skipped: result.skipped.map((entry) => ({
      assetId: entry.assetId,
      reason: entry.reason,
    })),
  };
}

async function defaultResolveDependencyContext(
  manifest: RendererBundleManifest,
  env: NodeJS.ProcessEnv,
): Promise<RendererBundleDependencyContext> {
  const requiredRuntimeAssets = stringArray(manifest.requiredRuntimeAssets);
  const requiredResources = stringArray(manifest.requiredResources);
  const context: RendererBundleDependencyContext = {};

  if (requiredRuntimeAssets.length > 0) {
    const status = await getRuntimeAssetsStatus({ resolverOptions: { env } });
    context.availableRuntimeAssets = status.assets
      .filter((asset) => asset.state !== 'missing')
      .map((asset) => asset.id);
  }

  if (requiredResources.length > 0) {
    context.availableResources = requiredResources.filter((resource) =>
      resolveExistingResource(resource, { env }) !== null
    );
  }

  return context;
}

async function defaultPrepareRuntimeAssets(
  _missingAssets?: readonly string[],
  _manifest?: RendererBundleManifest,
): Promise<PrepareRuntimeAssetsResult> {
  const updateService = await import('../cloud/updateService');
  if (!updateService.isUpdateServiceInitialized()) {
    return {
      installed: [],
      skipped: [{ assetId: '*', reason: 'update service not initialized' }],
    };
  }
  return updateService.getUpdateService().prepareRuntimeAssets();
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest fetch HTTP ${res.status}`);
  return res.json();
}

async function defaultDownloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`bundle download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
}

async function defaultExtractArchive(archivePath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], { maxBuffer: 64 * 1024 * 1024 });
}

export async function applyRendererBundleUpdate(
  options: RendererBundleFetcherOptions,
): Promise<RendererBundleApplyResult> {
  const {
    dataDir,
    currentShellVersion,
    manifestUrl: manifestUrlOverride,
    env = process.env,
    publicKeys = getControlPlanePublicKeysFromEnv(),
    now,
    fetchJson = defaultFetchJson,
    downloadToFile = defaultDownloadToFile,
    extractArchive = defaultExtractArchive,
    logger = () => {},
    disabledReason = getRendererHotUpdateDisabledReason(env),
    recordTelemetryAttempt = recordRendererBundleTelemetryAttempt,
    resolveDependencyContext = (manifest) => defaultResolveDependencyContext(manifest, env),
    autoPrepareRuntimeAssets = true,
    prepareRuntimeAssets = (missingAssets, manifest) => defaultPrepareRuntimeAssets(missingAssets, manifest),
    rolloutPolicyUrl: rolloutPolicyUrlOverride,
    rolloutSeed = buildDefaultRolloutSeed(dataDir),
    rolloutCohort = env[RENDERER_BUNDLE_COHORT_ENV],
    platform = process.platform,
  } = options;
  const checkedAt = new Date(now ?? Date.now()).toISOString();
  let manifestUrl = manifestUrlOverride ?? resolveRendererBundleEndpoint({}).manifestUrl;
  let rolloutAttempt: RendererBundleRolloutAttemptStatus | undefined;
  let runtimeAssetPreparation: RendererBundleRuntimeAssetPreparationStatus | undefined;

  const recordAttempt = async (attempt: Omit<RendererBundleLastAttemptStatus, 'checkedAt' | 'manifestUrl' | 'currentShellVersion'>) => {
    try {
      const status = await writeRendererBundleLastAttempt(
        dataDir,
        {
          checkedAt,
          manifestUrl,
          currentShellVersion,
          ...(rolloutAttempt ? { rollout: rolloutAttempt } : {}),
          ...(runtimeAssetPreparation ? { runtimeAssetPreparation } : {}),
          ...attempt,
        },
        env,
      );
      try {
        await recordTelemetryAttempt(status);
      } catch (err) {
        logger(`[renderer-hot-update] telemetry record failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      logger(`[renderer-hot-update] status write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (disabledReason) {
    logger(`[renderer-hot-update] disabled by ${disabledReason}`);
    await recordAttempt({
      outcome: 'skipped',
      reason: 'disabled',
    });
    return { applied: false, reason: 'disabled' };
  }

  try {
    const endpoint = resolveRendererBundleEndpoint(env);
    manifestUrl = manifestUrlOverride ?? endpoint.manifestUrl;
    const rolloutPolicyUrl = manifestUrlOverride || endpoint.manifestUrlOverride
      ? null
      : (rolloutPolicyUrlOverride === undefined ? endpoint.rolloutPolicyUrl ?? null : rolloutPolicyUrlOverride);

    if (rolloutPolicyUrl) {
      try {
        const rolloutEnvelope = await fetchJson(rolloutPolicyUrl);
        const rolloutTrust = verifyControlPlaneEnvelope<RendererBundleRolloutPolicy>(rolloutEnvelope, {
          kind: 'renderer_bundle_rollout',
          publicKeys,
          ...(now !== undefined ? { now } : {}),
        });
        if (!rolloutTrust.trusted || !rolloutTrust.payload) {
          const diagnostics = rolloutTrust.diagnostics.map((diagnostic) => diagnostic.code);
          const formattedDiagnostics = formatControlPlaneDiagnostics(rolloutTrust.diagnostics);
          rolloutAttempt = {
            policyUrl: rolloutPolicyUrl,
            decision: 'untrusted',
            diagnostics,
          };
          logger(`[renderer-hot-update] rollout policy untrusted: ${formattedDiagnostics}`);
          await recordAttempt({
            outcome: 'failed',
            reason: 'rollout-policy-untrusted',
            diagnostics,
          });
          return { applied: false, reason: 'rollout-policy-untrusted' };
        }

        const rolloutDecision = decideRendererBundleRollout(rolloutTrust.payload, {
          currentShellVersion,
          fallbackEndpoint: endpoint,
          rolloutSeed,
          ...(rolloutCohort ? { cohort: rolloutCohort } : {}),
          platform,
        });

        if (rolloutDecision.action === 'skip') {
          rolloutAttempt = {
            policyUrl: rolloutPolicyUrl,
            decision: 'skip',
            ...(rolloutDecision.policyVersion ? { policyVersion: rolloutDecision.policyVersion } : {}),
            reason: rolloutDecision.reason,
            ...(rolloutDecision.errorMessage ? { errorMessage: rolloutDecision.errorMessage } : {}),
          };
          logger(`[renderer-hot-update] rollout skip: ${rolloutDecision.reason}`);
          await recordAttempt({
            outcome: rolloutDecision.reason === 'rollout-paused' ? 'skipped' : 'failed',
            reason: rolloutDecision.reason,
            ...(rolloutDecision.errorMessage ? { errorMessage: rolloutDecision.errorMessage } : {}),
          });
          return { applied: false, reason: rolloutDecision.reason };
        }

        if (rolloutDecision.action === 'rollback-to-builtin') {
          rolloutAttempt = {
            policyUrl: rolloutPolicyUrl,
            decision: 'rollback-to-builtin',
            policyVersion: rolloutDecision.policyVersion,
            reason: rolloutDecision.reason,
            ...(rolloutDecision.rollbackReason ? { rollbackReason: rolloutDecision.rollbackReason } : {}),
          };
          await clearRendererBundleActive(dataDir);
          await recordAttempt({
            outcome: 'rolled-back',
            reason: rolloutDecision.reason,
          });
          return { applied: false, reason: rolloutDecision.reason };
        }

        rolloutAttempt = {
          policyUrl: rolloutPolicyUrl,
          decision: 'use-manifest',
          policyVersion: rolloutDecision.policyVersion,
          rolloutApplied: rolloutDecision.rolloutApplied,
          ...(rolloutDecision.rolloutBucket !== undefined ? { rolloutBucket: rolloutDecision.rolloutBucket } : {}),
          ...(rolloutDecision.rolloutPercent !== undefined ? { rolloutPercent: rolloutDecision.rolloutPercent } : {}),
          ...(rolloutDecision.fallbackReason ? { fallbackReason: rolloutDecision.fallbackReason } : {}),
        };
        manifestUrl = rolloutDecision.manifestUrl;
      } catch (err) {
        rolloutAttempt = {
          policyUrl: rolloutPolicyUrl,
          decision: 'unavailable',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        logger(`[renderer-hot-update] rollout policy unavailable: ${rolloutAttempt.errorMessage}`);
      }
    }

    // 1. 拉取签名 manifest envelope
    const envelope = await fetchJson(manifestUrl);

    // 2. 验签（kind=renderer_bundle），payload 即 RendererBundleManifest
    const trust = verifyControlPlaneEnvelope<RendererBundleManifest>(envelope, {
      kind: 'renderer_bundle',
      publicKeys,
      ...(now !== undefined ? { now } : {}),
    });
    if (!trust.trusted || !trust.payload) {
      logger(`[renderer-hot-update] envelope untrusted: ${formatControlPlaneDiagnostics(trust.diagnostics)}`);
      await recordAttempt({
        outcome: 'failed',
        reason: 'envelope-untrusted',
        diagnostics: trust.diagnostics.map((diagnostic) => diagnostic.code),
      });
      return { applied: false, reason: 'envelope-untrusted' };
    }
    const manifest = trust.payload;

    // 3. 契约门 + 兜底（invalid-manifest / shell-too-old / already-current）
    let decision = shouldApplyRendererBundle(manifest, {
      currentShellVersion,
      activeContentHash: readActiveContentHash(dataDir),
      shellCapabilities: getShellCapabilityIds(),
      ...await resolveDependencyContext(manifest),
    });
    if (!decision.apply && decision.reason === 'missing-runtime-asset' && autoPrepareRuntimeAssets) {
      logger(`[renderer-hot-update] preparing runtime assets: ${decision.missingRuntimeAssets.join(',')}`);
      try {
        const prepared = await prepareRuntimeAssets(decision.missingRuntimeAssets, manifest);
        runtimeAssetPreparation = summarizeRuntimeAssetPreparation(prepared);
        decision = shouldApplyRendererBundle(manifest, {
          currentShellVersion,
          activeContentHash: readActiveContentHash(dataDir),
          shellCapabilities: getShellCapabilityIds(),
          ...await resolveDependencyContext(manifest),
        });
      } catch (err) {
        runtimeAssetPreparation = {
          attempted: true,
          installed: [],
          skipped: [],
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (!decision.apply) {
      logger(`[renderer-hot-update] skip: ${decision.reason}`);
      if (decision.reason === 'rollback-to-builtin') {
        await clearRendererBundleActive(dataDir);
        await recordAttempt({
          outcome: 'rolled-back',
          reason: decision.reason,
          ...manifestStatusPatch(manifest),
        });
        return { applied: false, reason: decision.reason };
      }
      await recordAttempt({
        outcome: outcomeForPolicySkip(decision.reason),
        reason: decision.reason,
        ...manifestStatusPatch(manifest),
        ...(
          decision.reason === 'missing-shell-capability'
            ? { missingShellCapabilities: decision.missingShellCapabilities }
            : {}
        ),
        ...(
          decision.reason === 'missing-runtime-asset'
            ? { missingRuntimeAssets: decision.missingRuntimeAssets }
            : {}
        ),
        ...(
          decision.reason === 'missing-resource'
            ? { missingResources: decision.missingResources }
            : {}
        ),
      });
      return { applied: false, reason: decision.reason };
    }

    const bundleUrl = manifest.bundleUrl;
    const contentHash = manifest.contentHash;
    if (!bundleUrl || !contentHash) {
      await recordAttempt({
        outcome: 'failed',
        reason: 'invalid-manifest',
        ...manifestStatusPatch(manifest),
      });
      return { applied: false, reason: 'invalid-manifest' };
    }

    // 4. 准备干净的 pending 工作目录（绝不动 active）
    const pending = pendingBundleDir(dataDir);
    await fs.rm(pending, { recursive: true, force: true });
    await fs.mkdir(rendererCacheDir(dataDir), { recursive: true });
    await fs.mkdir(pending, { recursive: true });
    const archivePath = join(pending, 'bundle.tar.gz');

    // 5. 下载 → sha256 完整性校验
    await downloadToFile(bundleUrl, archivePath);
    const intact = await verifyBundleIntegrity(archivePath, contentHash);
    if (!intact) {
      logger('[renderer-hot-update] integrity mismatch');
      await fs.rm(pending, { recursive: true, force: true });
      await recordAttempt({
        outcome: 'failed',
        reason: 'integrity-mismatch',
        ...manifestStatusPatch(manifest),
      });
      return { applied: false, reason: 'integrity-mismatch' };
    }

    // 6. 解压到 pending/extract → 校验解压健康（index.html 必须存在）
    const extractDir = join(pending, 'extract');
    await extractArchive(archivePath, extractDir);
    if (!existsSync(join(extractDir, 'index.html'))) {
      logger('[renderer-hot-update] extracted bundle missing index.html');
      await fs.rm(pending, { recursive: true, force: true });
      await recordAttempt({
        outcome: 'failed',
        reason: 'extract-unhealthy',
        ...manifestStatusPatch(manifest),
      });
      return { applied: false, reason: 'extract-unhealthy' };
    }

    // 7. 写 meta 进 extractDir，再原子 rename(extract→active)。
    //    到这一步才动 active：先删旧 active 再 rename，window 极短且 rename 同 fs 原子。
    await fs.writeFile(
      join(extractDir, '.bundle-meta.json'),
      JSON.stringify({ version: manifest.version, contentHash }),
      'utf8',
    );
    const active = activeBundleDir(dataDir);
    await fs.rm(active, { recursive: true, force: true });
    await fs.rename(extractDir, active);
    await fs.rm(pending, { recursive: true, force: true });

    logger(`[renderer-hot-update] applied bundle ${manifest.version}`);
    await recordAttempt({
      outcome: 'applied',
      ...manifestStatusPatch(manifest),
    });
    return { applied: true, version: manifest.version, contentHash };
  } catch (err) {
    // 兜底铁律：任何异常都不破坏当前前端
    if (err instanceof RendererBundleEndpointError) {
      manifestUrl = err.target;
    }
    const reason = err instanceof RendererBundleEndpointError ? err.code : 'error';
    logger(`[renderer-hot-update] failed: ${err instanceof Error ? err.message : String(err)}`);
    await recordAttempt({
      outcome: 'failed',
      reason,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { applied: false, reason };
  }
}
