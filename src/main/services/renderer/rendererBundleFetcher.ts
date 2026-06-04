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
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from '../cloud/controlPlaneTrust';
import { RENDERER_BUNDLE_ENDPOINTS } from '../../../shared/constants/network';
import { shouldApplyRendererBundle, type RendererBundleManifest } from './rendererBundlePolicy';
import { verifyBundleIntegrity } from './rendererBundleIntegrity';
import {
  activeBundleDir,
  pendingBundleDir,
  rendererCacheDir,
  readActiveContentHash,
} from './rendererBundleCache';

const execFileAsync = promisify(execFile);

export interface RendererBundleFetcherOptions {
  /** 数据目录（~/.code-agent） */
  dataDir: string;
  /** 当前壳（app）版本，喂契约门 */
  currentShellVersion: string;
  /** 签名 manifest URL，默认 OSS 常量 */
  manifestUrl?: string;
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
}

export type RendererBundleApplyResult =
  | { applied: true; version: string; contentHash: string }
  | { applied: false; reason: string };

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
    manifestUrl = RENDERER_BUNDLE_ENDPOINTS.manifestUrl,
    publicKeys = getControlPlanePublicKeysFromEnv(),
    now,
    fetchJson = defaultFetchJson,
    downloadToFile = defaultDownloadToFile,
    extractArchive = defaultExtractArchive,
    logger = () => {},
  } = options;

  try {
    // 1. 拉取签名 manifest envelope
    const envelope = await fetchJson(manifestUrl);

    // 2. 验签（kind=renderer_bundle），payload 即 RendererBundleManifest
    const trust = verifyControlPlaneEnvelope<RendererBundleManifest>(envelope, {
      kind: 'renderer_bundle',
      publicKeys,
      ...(now !== undefined ? { now } : {}),
    });
    if (!trust.trusted || !trust.payload) {
      logger(`[renderer-hot-update] envelope untrusted: ${trust.diagnostics.map((d) => d.code).join(',')}`);
      return { applied: false, reason: 'envelope-untrusted' };
    }
    const manifest = trust.payload;

    // 3. 契约门 + 兜底（invalid-manifest / shell-too-old / already-current）
    const decision = shouldApplyRendererBundle(manifest, {
      currentShellVersion,
      activeContentHash: readActiveContentHash(dataDir),
    });
    if (!decision.apply) {
      logger(`[renderer-hot-update] skip: ${decision.reason}`);
      return { applied: false, reason: decision.reason };
    }

    // 4. 准备干净的 pending 工作目录（绝不动 active）
    const pending = pendingBundleDir(dataDir);
    await fs.rm(pending, { recursive: true, force: true });
    await fs.mkdir(rendererCacheDir(dataDir), { recursive: true });
    await fs.mkdir(pending, { recursive: true });
    const archivePath = join(pending, 'bundle.tar.gz');

    // 5. 下载 → sha256 完整性校验
    await downloadToFile(manifest.bundleUrl, archivePath);
    const intact = await verifyBundleIntegrity(archivePath, manifest.contentHash);
    if (!intact) {
      logger('[renderer-hot-update] integrity mismatch');
      await fs.rm(pending, { recursive: true, force: true });
      return { applied: false, reason: 'integrity-mismatch' };
    }

    // 6. 解压到 pending/extract → 校验解压健康（index.html 必须存在）
    const extractDir = join(pending, 'extract');
    await extractArchive(archivePath, extractDir);
    if (!existsSync(join(extractDir, 'index.html'))) {
      logger('[renderer-hot-update] extracted bundle missing index.html');
      await fs.rm(pending, { recursive: true, force: true });
      return { applied: false, reason: 'extract-unhealthy' };
    }

    // 7. 写 meta 进 extractDir，再原子 rename(extract→active)。
    //    到这一步才动 active：先删旧 active 再 rename，window 极短且 rename 同 fs 原子。
    await fs.writeFile(
      join(extractDir, '.bundle-meta.json'),
      JSON.stringify({ version: manifest.version, contentHash: manifest.contentHash }),
      'utf8',
    );
    const active = activeBundleDir(dataDir);
    await fs.rm(active, { recursive: true, force: true });
    await fs.rename(extractDir, active);
    await fs.rm(pending, { recursive: true, force: true });

    logger(`[renderer-hot-update] applied bundle ${manifest.version}`);
    return { applied: true, version: manifest.version, contentHash: manifest.contentHash };
  } catch (err) {
    // 兜底铁律：任何异常都不破坏当前前端
    logger(`[renderer-hot-update] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { applied: false, reason: 'error' };
  }
}
