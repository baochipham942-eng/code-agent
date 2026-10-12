// ============================================================================
// Presentation Preview Retention - pptx 逐页预览截图缓存的保留清理
// ----------------------------------------------------------------------------
// buildPresentationPagePreview（ipc/workspaceArchive.ipc.ts）把每页截图缓存在
// <dataDir>/cache/presentation-page-previews/<revision>/，revision 是 pptx 内容的
// sha256——每次编辑 deck 都会新增一个目录，旧目录此前没有任何回收路径。
//
// 删除前提（owner 规矩：扫描不可信就一个都不删）：
//   1) 先做只读引用扫描：会话消息（含 tool results / metadata / 隐藏回卷行）、
//      companion_artifacts 产物账本以及其他存产物/文件路径的表，找子串
//      `presentation-page-previews/<rev>`。Windows 落库的是反斜杠路径（path.join），
//      JSON 列里还成对转义，扫描前按分隔符归一。扫描抛错或读不全 → 本轮一个不删，记 1 次失败。
//   2) 不是 manifest.filePath 当前 revision（文件还在就重算 sha256；文件已不存在——
//      ENOENT/ENOTDIR——按无现行 revision 处理；读不出才保守保留）。
//   3) lastUsedAt 超 30 天，或（超出同 deck 保留的最新 3 个 revision 且超 7 天）。
// 没有 filePath 的旧 manifest 一律不动。
//
// 与 audioRetention 同一套记账（infra/retentionLedger）：只记日志不抛错。
// ============================================================================

import { promises as fsp } from 'fs';
import path from 'path';
import { PRESENTATION_PREVIEW_RETENTION } from '@shared/constants/presentationPreview';
import { getUserConfigDir } from '../../config/configPaths';
import { PRESENTATION_PREVIEW_CACHE_DIRNAME } from '../../tools/media/ppt/constants';
import { computeArtifactRevision } from '../../tools/artifacts/artifactLocatorHost';
import { createLogger } from './logger';
import { countRetentionFailed, createRetentionLedger, type RetentionFailureCounter } from './retentionLedger';
import { collectReferenceText } from './retentionReferenceScan';

const logger = createLogger('PresentationPreviewRetention');

/** sha256 hex revision 目录名（computeArtifactRevision 的产物形状） */
const REVISION_DIR_NAME = /^[0-9a-f]{64}$/;

export interface PresentationPreviewRetentionSummary {
  deleted: number;
  failed: number;
  lastError?: string;
}

interface PreviewRevisionDir {
  dirName: string;
  dirPath: string;
  /** manifest.json 里的绝对 pptx 路径；旧 manifest 没有该字段 → 不参与回收 */
  filePath: string;
  lastUsedAt: number;
}

/**
 * 引用扫描（REFERENCE_SOURCES 表清单、LIKE 预筛、分隔符归一）已抽到
 * retentionReferenceScan（与 app 缓存保留清理共用），本文件只保留预览特有的判定逻辑。
 */

const retentionLedger = createRetentionLedger();

export async function sweepPresentationPreviewRetention(input?: {
  cacheRoot?: string;
  dbPath?: string | null;
  now?: number;
}): Promise<PresentationPreviewRetentionSummary> {
  const now = input?.now ?? Date.now();
  const cacheRoot = input?.cacheRoot
    ?? path.join(getUserConfigDir(), 'cache', PRESENTATION_PREVIEW_CACHE_DIRNAME);
  const dbPath = input?.dbPath ?? path.join(getUserConfigDir(), 'code-agent.db');
  const summary: PresentationPreviewRetentionSummary & RetentionFailureCounter = { deleted: 0, failed: 0 };

  try {
    const revisions = await listSweepableRevisionDirs(cacheRoot);
    if (revisions.length === 0) {
      retentionLedger.publish(summary.deleted, summary.failed, summary.lastError, now);
      return { ...summary };
    }

    // 删除前先完成整轮只读扫描：读不全就一个不删
    let referenceText: string;
    try {
      if (typeof dbPath !== 'string' || dbPath.length === 0) {
        throw new Error('database path unavailable');
      }
      referenceText = await collectReferenceText(dbPath, [`${PRESENTATION_PREVIEW_CACHE_DIRNAME}_`]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('[预览保留] 引用扫描失败，本轮不删除任何目录', { reason });
      countRetentionFailed(summary, reason);
      retentionLedger.publish(summary.deleted, summary.failed, summary.lastError, now);
      return { ...summary };
    }

    const deletable = await pickDeletableRevisions(revisions, referenceText, now);
    for (const revision of deletable) {
      try {
        await fsp.rm(revision.dirPath, { recursive: true });
        summary.deleted += 1;
      } catch (error) {
        // 上一轮与这一轮之间已被别人清掉：不算删除也不算失败
        if (isNodeError(error, 'ENOENT')) continue;
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('[预览保留] 删除预览缓存目录失败', { path: revision.dirPath, reason });
        countRetentionFailed(summary, reason);
      }
    }
    if (summary.deleted > 0) {
      logger.info('[预览保留] 已回收预览缓存目录', { deleted: summary.deleted, cacheRoot });
    }
  } catch (error) {
    // 列目录阶段失败：一个不删，记 1 次失败（与扫描失败同一口径）
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('[预览保留] 清理过程失败', { reason });
    countRetentionFailed(summary, reason);
  }

  retentionLedger.publish(summary.deleted, summary.failed, summary.lastError, now);
  return { ...summary };
}

/** 列出可参与回收判断的 revision 目录：manifest 可读、revision 与目录名一致、有 filePath + lastUsedAt。 */
async function listSweepableRevisionDirs(cacheRoot: string): Promise<PreviewRevisionDir[]> {
  let entries;
  try {
    entries = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return []; // 缓存根不存在或不可读：没有可清理对象
  }

  const revisions: PreviewRevisionDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!REVISION_DIR_NAME.test(entry.name)) continue;
    const dirPath = path.join(cacheRoot, entry.name);
    try {
      const raw = await fsp.readFile(path.join(dirPath, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        revision?: unknown;
        filePath?: unknown;
        lastUsedAt?: unknown;
      };
      // 旧 manifest（无 filePath/lastUsedAt）与对不上号的目录一律不动
      if (parsed.revision !== entry.name) continue;
      if (typeof parsed.filePath !== 'string' || parsed.filePath.length === 0) continue;
      if (typeof parsed.lastUsedAt !== 'number' || !Number.isFinite(parsed.lastUsedAt)) continue;
      revisions.push({ dirName: entry.name, dirPath, filePath: parsed.filePath, lastUsedAt: parsed.lastUsedAt });
    } catch {
      // manifest 读不出（转换中途/外来目录）：不动它
      continue;
    }
  }
  return revisions;
}

/**
 * 只读引用扫描（retentionReferenceScan.collectReferenceText）：needle 用 LIKE 的 `_`
 * 单字符通配兜住 `/` 与 `\` 两种分隔符（Windows 写入点是 path.join 的反斜杠路径，
 * JSON 列里还成对转义）——宁可多捞，精筛在 isReferenced。归一也在扫描内完成。
 */

/** 引用判定：按子串 `presentation-page-previews/<rev>` 精确匹配（64 位 hex 定长，无前缀误伤；输入已归一分隔符）。 */
function isReferenced(referenceText: string, dirName: string): boolean {
  return referenceText.includes(`${PRESENTATION_PREVIEW_CACHE_DIRNAME}/${dirName}`);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

/**
 * 可删除判定：未引用 && 不是该 filePath 的当前 revision &&（超 30 天未用，或超出
 * 同 deck 最新 3 个且超 7 天）。deck 文件已不存在（ENOENT/ENOTDIR）= 无现行 revision；
 * sha256 其他读失败按「可能是当前 revision」保守保留。
 */
async function pickDeletableRevisions(
  revisions: PreviewRevisionDir[],
  referenceText: string,
  now: number,
): Promise<PreviewRevisionDir[]> {
  const deletable: PreviewRevisionDir[] = [];
  // sha256 结果按 deck 缓存：值三态 —— string 当前 revision / null 文件已不存在 / undefined 读不出
  const currentCache = new Map<string, string | null | undefined>();

  // 按 deck（filePath）分组，组内按 lastUsedAt 新→旧排，前 KEEP_REVISIONS_PER_DECK 个受 7 天短保留期保护
  const byDeck = new Map<string, PreviewRevisionDir[]>();
  for (const revision of revisions) {
    const group = byDeck.get(revision.filePath);
    if (group) group.push(revision);
    else byDeck.set(revision.filePath, [revision]);
  }

  for (const [filePath, group] of byDeck) {
    group.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
    for (let index = 0; index < group.length; index += 1) {
      const revision = group[index];
      if (isReferenced(referenceText, revision.dirName)) continue;

      if (!currentCache.has(filePath)) {
        currentCache.set(filePath, await resolveCurrentRevision(filePath));
      }
      const currentRevision = currentCache.get(filePath);
      // undefined = sha256 读不出，无法证明「不是当前 revision」→ 保守保留
      if (currentRevision === undefined || currentRevision === revision.dirName) continue;

      const ageMs = now - revision.lastUsedAt;
      const beyondKeep = index >= PRESENTATION_PREVIEW_RETENTION.KEEP_REVISIONS_PER_DECK;
      const due = ageMs >= PRESENTATION_PREVIEW_RETENTION.UNUSED_MS
        || (beyondKeep && ageMs >= PRESENTATION_PREVIEW_RETENTION.EXCESS_MS);
      if (due) deletable.push(revision);
    }
  }
  return deletable;
}

/**
 * deck 文件还在就重算 sha256。文件已不存在（ENOENT/ENOTDIR：被删、被挪、中间路径成了文件）
 * 返回 null——deck 已不在该路径，无当前 revision 可保护，正常走年龄/名额判定。
 * 其他读失败（EACCES/EISDIR 等，路径上有东西但算不出 sha256）返回 undefined：无法证明
 * 「不是当前 revision」，保守保留。
 */
async function resolveCurrentRevision(filePath: string): Promise<string | null | undefined> {
  try {
    const revision = await computeArtifactRevision(filePath);
    return revision.value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return null;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('[预览保留] 无法重算 deck 当前 revision，保守保留其预览目录', { path: filePath, reason });
    return undefined;
  }
}

let kickoffStarted = false;

/**
 * 启动即扫一次，之后每天扫一次（fire-and-forget，绝不阻塞 listen；timer unref 不拖住进程）。
 * 失败只在 sweep 内部 warn + 计失败，这里不再上抛。
 */
export function kickoffPresentationPreviewRetention(): void {
  if (kickoffStarted) return;
  kickoffStarted = true;
  const runSweep = (): void => {
    void sweepPresentationPreviewRetention().catch((error) => {
      logger.warn('[预览保留] 清理过程失败', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  };
  runSweep();
  const timer = setInterval(runSweep, PRESENTATION_PREVIEW_RETENTION.SWEEP_INTERVAL_MS);
  timer.unref();
}
