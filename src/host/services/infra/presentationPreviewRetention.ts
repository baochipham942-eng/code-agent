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
//      `presentation-page-previews/<rev>`。扫描抛错或读不全 → 本轮一个不删，记 1 次失败。
//   2) 不是 manifest.filePath 当前 revision（文件还在就重算 sha256；文件没了自然不是）。
//   3) lastUsedAt 超 30 天，或（超出同 deck 保留的最新 3 个 revision 且超 7 天）。
// 没有 filePath 的旧 manifest 一律不动。
//
// 与 audioRetention 同一套记账（infra/retentionLedger）：只记日志不抛错。
// ============================================================================

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { PRESENTATION_PREVIEW_RETENTION } from '@shared/constants/presentationPreview';
import { getUserConfigDir } from '../../config/configPaths';
import { PRESENTATION_PREVIEW_CACHE_DIRNAME } from '../../tools/media/ppt/constants';
import { computeArtifactRevision } from '../../tools/artifacts/artifactLocatorHost';
import { createLogger } from './logger';
import { countRetentionFailed, createRetentionLedger, type RetentionFailureCounter } from './retentionLedger';

const logger = createLogger('PresentationPreviewRetention');

const execFileAsync = promisify(execFile);

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
 * 引用扫描覆盖的表和文本列。消息表是主源；其余是任务书点名/排查补充的
 * 「存产物/文件路径」的表，少扫一张就可能删掉仍被引用的目录。
 */
const REFERENCE_SOURCES: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'messages', columns: ['content', 'tool_calls', 'tool_results', 'responses_output', 'attachments', 'compaction', 'metadata'] },
  { table: 'companion_artifacts', columns: ['path'] },
  { table: 'tool_executions', columns: ['arguments', 'result'] },
  { table: 'turn_snapshots', columns: ['context_chunks'] },
  { table: 'compaction_snapshots', columns: ['pre_messages_summary', 'post_messages_summary'] },
  { table: 'file_checkpoints', columns: ['file_path', 'original_content'] },
  { table: 'workflow_runs', columns: ['result_json'] },
  { table: 'workflow_run_calls', columns: ['result_json'] },
  { table: 'session_fork_anchor_evidence', columns: ['summary_json', 'evidence_json'] },
];

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
      referenceText = await collectReferenceText(dbPath);
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
 * 只读引用扫描：对每张表跑一次 LIKE 预筛，把命中行的文本列拼成一段大文本。
 * 任一表查询失败（表缺失 / 库打不开 / 输出超限）→ 抛错，由调用方记 1 次失败并放弃本轮删除。
 */
async function collectReferenceText(dbPath: string): Promise<string> {
  const chunks: string[] = [];
  for (const source of REFERENCE_SOURCES) {
    // 常量目录名不含引号/通配符，直接内插；列名是本文件维护的白名单
    const like = source.columns
      .map((column) => `${column} LIKE '%${PRESENTATION_PREVIEW_CACHE_DIRNAME}/%'`)
      .join(' OR ');
    const sql = `SELECT ${source.columns.join(', ')} FROM ${source.table} WHERE ${like};`;
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) continue;
    const rows = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(rows)) {
      throw new Error(`${source.table} query did not return a JSON array`);
    }
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) chunks.push(value);
      }
    }
  }
  return chunks.join('\n');
}

/** 引用判定：按子串 `presentation-page-previews/<rev>` 精确匹配（64 位 hex 定长，无前缀误伤）。 */
function isReferenced(referenceText: string, dirName: string): boolean {
  return referenceText.includes(`${PRESENTATION_PREVIEW_CACHE_DIRNAME}/${dirName}`);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

/**
 * 可删除判定：未引用 && 不是该 filePath 的当前 revision &&（超 30 天未用，或超出
 * 同 deck 最新 3 个且超 7 天）。sha256 重算失败按「可能是当前 revision」保守保留。
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

/** deck 文件还在就重算 sha256；文件没了返回 null（deck 已不存在，无当前 revision 可保护）。读失败返回 undefined（保守保留）。 */
async function resolveCurrentRevision(filePath: string): Promise<string | null | undefined> {
  try {
    const revision = await computeArtifactRevision(filePath);
    return revision.value;
  } catch (error) {
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
