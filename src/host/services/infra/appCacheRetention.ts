// ============================================================================
// App Cache Retention - 三个 app 自有缓存目录的保留清理
// ----------------------------------------------------------------------------
// channel-media（飞书/lark 消息媒体转存，feishuMedia）、托管浏览器页面截图
// （browserService/screenshots）、appshots（Rust 热键窗口捕捉）三个目录此前
// 只有写入方、没有回收方，会无限增长。本模块按 age + total-size 双阈值回收，
// 且只删没有任何会话引用的文件——引用扫描与 pptx 预览清理共用
// retentionReferenceScan，记账共用 retentionLedger。
//
// 规矩（owner 口径：宁可漏删，不可误删）：
//   - 删除前先完成整轮只读引用扫描；扫描抛错/读不全（表缺失/库打不开）→
//     本轮三个目录一个都不删，记 1 次失败。
//   - 引用判定：channel-media = 归一文本含 `channel-media/<相对路径>`；
//     截图 = 文本含文件基名；appshots = 文本含文件 stem（`appshot-<ms>`，
//     会话以 attachment id 引用、附件数据落库时已剥离，只剩 id 文本）。
//   - 候选只认常规文件（symlink/目录一律跳过）；截图目录只认 *.png——
//     storage_state_*.json（浏览器会话状态，含 cookie）永不触碰。
//   - 写入不足 MIN_AGE（24h 地板）的文件一律不动。
//   - 超龄未引用先删；删后仍超总量上限的，从未引用的最旧候选继续删到 ≤ 上限，
//     候选耗尽就停——被引用/过新的文件宁可留着超上限。
// ============================================================================

import { promises as fsp } from 'fs';
import path from 'path';
import { APP_CACHE_RETENTION } from '@shared/constants/appCacheRetention';
import { getUserConfigDir } from '../../config/configPaths';
import { getUserDataPath } from '../../platform/appPaths';
import { CHANNEL_MEDIA_CACHE_DIRNAME, defaultChannelMediaCacheRoot } from '../../channels/feishu/feishuMedia';
import { MANAGED_BROWSER_ARTIFACT_DIR } from './browser/managedBrowserHelpers';
import { createLogger } from './logger';
import { countRetentionFailed, createRetentionLedger, type RetentionFailureCounter } from './retentionLedger';
import { collectReferenceText, normalizeSeparators } from './retentionReferenceScan';

const logger = createLogger('AppCacheRetention');

/** appshots 目录名（写入方在 Rust：src-tauri/src/appshots.rs `appshots_dir()` = `<dataDir>/appshots`） */
const APPSHOT_DIR_NAME = 'appshots';

/**
 * 引用预筛 needle（宁可多捞，精筛在各 kind 的 isReferenced）：
 * channel-media 引用必含目录名；截图引用必含 `<基名>.png`；appshots 引用
 * （attachment id / 文件名）必含 `appshot-` 前缀。
 */
const SCAN_NEEDLES: readonly string[] = [CHANNEL_MEDIA_CACHE_DIRNAME, '.png', 'appshot-'];

export type AppCacheDirKind = 'channel-media' | 'screenshots' | 'appshots';

export interface AppCacheDirSpec {
  kind: AppCacheDirKind;
  /** 该 kind 的目录根（缺省由 defaultAppCacheDirs 按写入方逻辑解析） */
  root: string;
  /** 覆盖常量缺省阈值（测试用小值走同一入口，不另开测试后门） */
  maxAgeMs?: number;
  maxTotalBytes?: number;
}

export interface AppCacheRetentionSummary {
  deleted: number;
  failed: number;
  lastError?: string;
}

interface CachedFile {
  filePath: string;
  /** 相对目录根的路径，分隔符已归一为 `/`（与引用文本同形） */
  relativePath: string;
  baseName: string;
  stem: string;
  sizeBytes: number;
  mtimeMs: number;
}

interface CacheDirPolicy {
  kind: AppCacheDirKind;
  root: string;
  maxAgeMs: number;
  maxTotalBytes: number;
  /** 候选过滤（screenshots 只认 *.png；storage_state_*.json 等永不入候选） */
  isCandidate: (baseName: string) => boolean;
  /** 引用判定（referenceText 已按分隔符归一） */
  isReferenced: (referenceText: string, file: CachedFile) => boolean;
}

/** 三个目录的缺省根：与各自写入方同一套 data-dir 解析，写入哪棵树就扫哪棵树。 */
function defaultAppCacheDirs(): AppCacheDirSpec[] {
  return [
    // feishuMedia.buildCacheDir 的缺省根（getUserConfigDir 尊重 CODE_AGENT_DATA_DIR）
    { kind: 'channel-media', root: defaultChannelMediaCacheRoot() },
    // browserService ctor：app.getPath('userData') + MANAGED_BROWSER_ARTIFACT_DIR
    { kind: 'screenshots', root: path.join(getUserDataPath(), MANAGED_BROWSER_ARTIFACT_DIR) },
    // Rust appshots_dir()：$CODE_AGENT_DATA_DIR || ~/.code-agent + /appshots（Node 侧同源解析）
    { kind: 'appshots', root: path.join(getUserDataPath(), APPSHOT_DIR_NAME) },
  ];
}

function resolvePolicy(spec: AppCacheDirSpec): CacheDirPolicy {
  switch (spec.kind) {
    case 'channel-media':
      return {
        kind: spec.kind,
        root: spec.root,
        maxAgeMs: spec.maxAgeMs ?? APP_CACHE_RETENTION.CHANNEL_MEDIA_MAX_AGE_MS,
        maxTotalBytes: spec.maxTotalBytes ?? APP_CACHE_RETENTION.CHANNEL_MEDIA_MAX_TOTAL_BYTES,
        isCandidate: () => true,
        isReferenced: (referenceText, file) => referenceText.includes(`${CHANNEL_MEDIA_CACHE_DIRNAME}/${file.relativePath}`),
      };
    case 'screenshots':
      return {
        kind: spec.kind,
        root: spec.root,
        maxAgeMs: spec.maxAgeMs ?? APP_CACHE_RETENTION.SCREENSHOT_MAX_AGE_MS,
        maxTotalBytes: spec.maxTotalBytes ?? APP_CACHE_RETENTION.SCREENSHOT_MAX_TOTAL_BYTES,
        isCandidate: (baseName) => baseName.endsWith('.png'),
        isReferenced: (referenceText, file) => referenceText.includes(file.baseName),
      };
    case 'appshots':
      return {
        kind: spec.kind,
        root: spec.root,
        maxAgeMs: spec.maxAgeMs ?? APP_CACHE_RETENTION.APPSHOT_MAX_AGE_MS,
        maxTotalBytes: spec.maxTotalBytes ?? APP_CACHE_RETENTION.APPSHOT_MAX_TOTAL_BYTES,
        isCandidate: () => true,
        // 12 位 ms 截断误命中只会多保留（前缀包含），方向安全
        isReferenced: (referenceText, file) => referenceText.includes(file.stem),
      };
  }
}

const appCacheRetentionLedger = createRetentionLedger();

export async function sweepAppCacheRetention(input?: {
  dirs?: readonly AppCacheDirSpec[];
  dbPath?: string | null;
  now?: number;
}): Promise<AppCacheRetentionSummary> {
  const now = input?.now ?? Date.now();
  const dirs = input?.dirs ?? defaultAppCacheDirs();
  const dbPath = input?.dbPath ?? path.join(getUserConfigDir(), 'code-agent.db');
  const summary: AppCacheRetentionSummary & RetentionFailureCounter = { deleted: 0, failed: 0 };

  // 删除前先完成整轮只读扫描：读不全就三个目录一个都不删
  let referenceText: string;
  try {
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new Error('database path unavailable');
    }
    referenceText = await collectReferenceText(dbPath, SCAN_NEEDLES);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('[应用缓存保留] 引用扫描失败，本轮不删除任何文件', { reason });
    countRetentionFailed(summary, reason);
    appCacheRetentionLedger.publish(summary.deleted, summary.failed, summary.lastError, now);
    return { ...summary };
  }

  for (const spec of dirs) {
    try {
      summary.deleted += await sweepCacheDir(resolvePolicy(spec), referenceText, now, summary);
    } catch (error) {
      // 单目录失败（列目录被拒等）：该目录本轮不删，记 1 次失败，其余目录继续
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('[应用缓存保留] 目录清理失败', { kind: spec.kind, root: spec.root, reason });
      countRetentionFailed(summary, reason);
    }
  }
  if (summary.deleted > 0) {
    logger.info('[应用缓存保留] 已回收缓存文件', { deleted: summary.deleted });
  }
  appCacheRetentionLedger.publish(summary.deleted, summary.failed, summary.lastError, now);
  return { ...summary };
}

/**
 * 递归列常规文件（symlink/目录跳过；channel-media 树有 platform/account 两层子目录）。
 * 根目录不存在（ENOENT）= 无文件；其他读失败上抛由调用方记失败。
 */
async function listRegularFiles(root: string): Promise<CachedFile[]> {
  const files: CachedFile[] = [];
  await walkDir(root, root, files);
  return files;
}

async function walkDir(dir: string, root: string, out: CachedFile[]): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT') && dir === root) return; // 目录还不存在：没有可清理对象
    throw error;
  }
  for (const entry of entries) {
    // Dirent 反映链接本身：symlink isFile()=false → 天然跳过，也不会成环
    if (entry.isDirectory()) {
      await walkDir(path.join(dir, entry.name), root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(filePath);
      out.push({
        filePath,
        relativePath: normalizeSeparators(path.relative(root, filePath)),
        baseName: entry.name,
        stem: path.basename(entry.name, path.extname(entry.name)),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      continue; // stat 竞态（刚被别人删）：不删它也不算失败
    }
  }
}

async function sweepCacheDir(
  policy: CacheDirPolicy,
  referenceText: string,
  now: number,
  failures: RetentionFailureCounter,
): Promise<number> {
  const files = await listRegularFiles(policy.root);
  if (files.length === 0) return 0;

  // 删除资格：候选扩展名 + 过 24h 地板 + 未被引用
  const eligible = files.filter((file) =>
    policy.isCandidate(file.baseName)
    && now - file.mtimeMs >= APP_CACHE_RETENTION.MIN_AGE_MS
    && !policy.isReferenced(referenceText, file));

  const removed = new Set<string>();
  // 1) 超龄：到保留期的未引用文件直接回收
  for (const file of eligible) {
    if (now - file.mtimeMs >= policy.maxAgeMs) {
      await deleteCachedFile(file, removed, failures);
    }
  }
  // 2) 超量：目录总量（全部常规文件，含被引用/非候选）仍超上限时，
  //    从未引用的最旧候选继续删到 ≤ 上限；候选耗尽就停
  let totalBytes = 0;
  for (const file of files) totalBytes += file.sizeBytes;
  for (const file of files) {
    if (removed.has(file.filePath)) totalBytes -= file.sizeBytes;
  }
  if (totalBytes > policy.maxTotalBytes) {
    const byOldest = eligible
      .filter((file) => !removed.has(file.filePath))
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of byOldest) {
      if (totalBytes <= policy.maxTotalBytes) break;
      await deleteCachedFile(file, removed, failures);
      totalBytes -= file.sizeBytes;
    }
  }
  return removed.size;
}

async function deleteCachedFile(
  file: CachedFile,
  removed: Set<string>,
  failures: RetentionFailureCounter,
): Promise<void> {
  try {
    await fsp.rm(file.filePath);
    removed.add(file.filePath);
  } catch (error) {
    // 上一轮与这一轮之间已被别人清掉：不算删除也不算失败
    if (isNodeError(error, 'ENOENT')) return;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('[应用缓存保留] 删除缓存文件失败', { path: file.filePath, reason });
    countRetentionFailed(failures, reason);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

let kickoffStarted = false;

/**
 * 启动即扫一次，之后每天扫一次（fire-and-forget，绝不阻塞 listen；timer unref 不拖住进程）。
 * 失败只在 sweep 内部 warn + 计失败，这里不再上抛。
 */
export function kickoffAppCacheRetention(): void {
  if (kickoffStarted) return;
  kickoffStarted = true;
  const runSweep = (): void => {
    void sweepAppCacheRetention().catch((error) => {
      logger.warn('[应用缓存保留] 清理过程失败', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  };
  runSweep();
  const timer = setInterval(runSweep, APP_CACHE_RETENTION.SWEEP_INTERVAL_MS);
  timer.unref();
}
