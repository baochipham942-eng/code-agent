// ============================================================================
// Light Memory Consolidation — periodic LLM compress-without-loss闭环
//
// Replaces the manual "Please consolidate" hint with an automated pass that:
//   1. Gates on health (skip when memory is small & INDEX within budget — no token burn).
//   2. Feeds memory files to the quick model: "compress WITHOUT losing information"
//      (merge near-duplicates, delete strict redundancies).
//   3. Applies merges/deletes, then rebuilds INDEX.md deterministically from
//      frontmatter (INDEX stays within budget by reducing file count, not by
//      LLM-rewriting the index itself).
//
// Holds the Light Memory file philosophy — no vector store. Supports dry-run:
// produce the plan + before/after diff without touching disk, for verification.
// ============================================================================

import {
  listMemoryFiles,
  readMemoryFile,
  writeLightMemoryFile,
  deleteMemoryFile,
  getLightMemoryHealth,
  rebuildLightMemoryIndex,
  type LightMemoryFile,
} from './lightMemoryIpc';
import { quickTask } from '../model/quickModel';
import { withTimeout } from '../services/infra/timeoutController';
import { createLogger } from '../services/infra/logger';
import { MEMORY_CONSOLIDATION } from '../../shared/constants';

const logger = createLogger('MemoryConsolidation');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface MergeResultFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
}

export interface ConsolidationAction {
  kind: 'merge' | 'delete';
  /** Source filenames consumed by this action. */
  sources: string[];
  /** The merged file to write (merge only). */
  result?: MergeResultFile;
  /** Why this action is safe / information-preserving. */
  reason: string;
}

export interface ConsolidationReport {
  /** Whether the LLM pass actually ran (false = skipped because memory is healthy). */
  triggered: boolean;
  /** Whether changes were written to disk. */
  applied: boolean;
  dryRun: boolean;
  /** Why it triggered, was skipped, or was blocked. */
  reason: string;
  before: { fileCount: number; indexLineCount: number };
  after: { fileCount: number; indexLineCount: number };
  actions: ConsolidationAction[];
  /** Human-readable before/after summary for dry-run inspection. */
  diff: string;
  error?: string;
}

// ----------------------------------------------------------------------------
// Trigger gate
// ----------------------------------------------------------------------------

interface TriggerDecision {
  shouldRun: boolean;
  reason: string;
}

function decideTrigger(
  health: Awaited<ReturnType<typeof getLightMemoryHealth>>,
  fileCount: number,
): TriggerDecision {
  const reasons: string[] = [];
  if (health.indexTooLong) reasons.push(`INDEX over budget (${health.indexLineCount} lines)`);
  if (health.duplicateNames.length > 0) reasons.push(`${health.duplicateNames.length} duplicate name group(s)`);
  if (health.duplicateDescriptions.length > 0) {
    reasons.push(`${health.duplicateDescriptions.length} duplicate description group(s)`);
  }
  if (fileCount >= MEMORY_CONSOLIDATION.FILE_COUNT_THRESHOLD) {
    reasons.push(`file count ${fileCount} ≥ threshold ${MEMORY_CONSOLIDATION.FILE_COUNT_THRESHOLD}`);
  }

  return reasons.length > 0
    ? { shouldRun: true, reason: reasons.join('; ') }
    : { shouldRun: false, reason: `healthy: ${fileCount} files, INDEX ${health.indexLineCount} lines` };
}

// ----------------------------------------------------------------------------
// Prompt + parsing
// ----------------------------------------------------------------------------

const CONSOLIDATION_PROMPT = `你是记忆库整理器。下面是一组记忆文件（每个有 filename / name / description / type / 正文）。
你的任务：在【绝对不丢失任何独立信息】的前提下压缩这个记忆库。

唯一允许的操作是 merge：把内容高度重叠/可归并的若干文件合并成一个文件。
- 合并产物 result 的正文必须逐条保留所有来源文件里的每一条独立事实/决策/偏好，只去掉重复表述。
- 如果文件 B 的信息已被文件 A 完全覆盖，也用 merge：sources=["A.md","B.md"]，result.filename 用 A 的名字、result.content 用 A 的完整正文（这样 B 被去掉而信息一条不丢）。
- 严禁在没有对应 merge 产物的情况下删除任何文件——任何文件的消失都必须由一个把它列为 source 的 merge 来吸收。

铁律：
- 任何一条独立的事实/决策/偏好都不能丢。拿不准是否冗余就不要动。
- 不要为了压缩而牺牲信息；宁可少合并、宁可返回空。
- merge 的 result.filename 用描述性的英文短横线命名（不带 .md，可复用某个来源文件的名字）。
- result.type 取来源里更通用的那个；description 一句话概括。

只返回一个 JSON 对象，不要任何额外文字、不要 markdown 代码块：
{
  "actions": [
    { "kind": "merge", "sources": ["a.md","b.md"], "result": { "filename": "merged-topic", "name": "...", "description": "...", "type": "reference", "content": "合并后逐条保留全部独立事实的完整正文" }, "reason": "为什么这样合并不丢信息" }
  ]
}
如果没有任何可安全压缩的操作，返回 {"actions": []}。`;

/**
 * Build the file dump fed to the model, capped at MAX_INPUT_CHARS.
 * Always includes each file's header (filename/name/description/type); bodies are
 * truncated to share the remaining budget so all files stay visible for dup detection.
 */
function buildFilesDump(files: LightMemoryFile[]): string {
  const headers = files.map(
    (f) => `### ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\ntype: ${f.type}`,
  );
  const headerChars = headers.reduce((sum, h) => sum + h.length + 8, 0);
  const bodyBudget = Math.max(0, MEMORY_CONSOLIDATION.MAX_INPUT_CHARS - headerChars);
  const perFileBody = files.length > 0
    ? Math.max(MEMORY_CONSOLIDATION.MIN_FILE_BODY_CHARS, Math.floor(bodyBudget / files.length))
    : 0;

  return files
    .map((f, i) => {
      const body = f.content.length > perFileBody
        ? f.content.slice(0, perFileBody) + '\n…[truncated]'
        : f.content;
      return `${headers[i]}\n--- body ---\n${body}`;
    })
    .join('\n\n========\n\n');
}

interface ParsedPlan {
  actions: ConsolidationAction[];
}

function parsePlan(raw: string, knownFilenames: Set<string>): ParsedPlan | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const rawActions = (parsed as Record<string, unknown>).actions;
  if (!Array.isArray(rawActions)) return null;

  const actions: ConsolidationAction[] = [];
  for (const item of rawActions) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as Record<string, unknown>;
    const kind = a.kind;
    if (kind !== 'merge' && kind !== 'delete') continue;

    // sources must all reference files that actually exist (defensive against hallucination).
    const sources = Array.isArray(a.sources)
      ? a.sources.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
      : [];
    if (sources.length === 0 || !sources.every((s) => knownFilenames.has(s))) continue;

    const reason = typeof a.reason === 'string' ? a.reason : '';

    if (kind === 'delete') {
      actions.push({ kind: 'delete', sources, reason });
      continue;
    }

    // merge — require a usable result with non-empty content.
    const r = a.result;
    if (typeof r !== 'object' || r === null) continue;
    const rr = r as Record<string, unknown>;
    const content = typeof rr.content === 'string' ? rr.content.trim() : '';
    const filename = typeof rr.filename === 'string' ? rr.filename.trim() : '';
    if (!content || content.length < 40 || !filename) continue;

    actions.push({
      kind: 'merge',
      sources,
      reason,
      result: {
        filename,
        name: typeof rr.name === 'string' && rr.name.trim() ? rr.name.trim() : filename,
        description: typeof rr.description === 'string' ? rr.description.trim() : '',
        type: typeof rr.type === 'string' && rr.type.trim() ? rr.type.trim() : 'reference',
        content,
      },
    });
  }

  return { actions };
}

/**
 * Safety validation: a file may only be removed if it is absorbed by a merge in the
 * SAME plan (its content was rewritten into a surviving merge result). Any standalone
 * delete — the model claiming "covered by X" without producing X here — is rejected,
 * because it is an information-loss vector (caught during WS4 dry-run verification:
 * a bare `delete deploy-notes.md "covered by merged-…"` with no merge would have
 * silently dropped that file's unique facts).
 */
function validatePlan(actions: ConsolidationAction[]): {
  actions: ConsolidationAction[];
  rejected: ConsolidationAction[];
} {
  const mergeSources = new Set<string>();
  for (const a of actions) {
    if (a.kind === 'merge') for (const s of a.sources) mergeSources.add(s);
  }

  const kept: ConsolidationAction[] = [];
  const rejected: ConsolidationAction[] = [];
  for (const a of actions) {
    if (a.kind === 'merge') {
      kept.push(a);
    } else if (a.sources.every((s) => mergeSources.has(s))) {
      // Redundant with the merge's own source removal, but harmless — keep.
      kept.push(a);
    } else {
      rejected.push(a);
    }
  }
  return { actions: kept, rejected };
}

// ----------------------------------------------------------------------------
// Diff / projection
// ----------------------------------------------------------------------------

/** Filenames removed by an action (sources, minus a merge result that reuses a source name). */
function removedBy(action: ConsolidationAction): string[] {
  if (action.kind === 'delete') return action.sources;
  const keep = `${action.result?.filename}.md`;
  return action.sources.filter((s) => s !== keep);
}

function buildDiff(actions: ConsolidationAction[], before: number, after: number): string {
  if (actions.length === 0) return 'No safe consolidation actions proposed.';
  const lines: string[] = [`Files: ${before} → ${after}`, ''];
  for (const a of actions) {
    if (a.kind === 'merge') {
      lines.push(`MERGE: ${a.sources.join(' + ')} → ${a.result?.filename}.md`);
      lines.push(`  reason: ${a.reason}`);
      const preview = (a.result?.content ?? '').slice(0, 200).replace(/\n/g, ' ');
      lines.push(`  result(${a.result?.content.length ?? 0} chars): ${preview}…`);
    } else {
      lines.push(`DELETE: ${a.sources.join(', ')}`);
      lines.push(`  reason: ${a.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Main entry
// ----------------------------------------------------------------------------

/**
 * Run a Light Memory consolidation pass.
 * @param opts.dryRun when true, compute the plan + diff but never write to disk.
 * @param opts.force  bypass the health gate (manual / "consolidate now" trigger).
 */
export async function consolidateLightMemory(
  opts?: { dryRun?: boolean; force?: boolean },
): Promise<ConsolidationReport> {
  const dryRun = opts?.dryRun ?? false;
  const force = opts?.force ?? false;

  const [health, files] = await Promise.all([getLightMemoryHealth(), listMemoryFiles()]);
  const beforeCount = files.length;
  const before = { fileCount: beforeCount, indexLineCount: health.indexLineCount };

  const trigger = force
    ? { shouldRun: true, reason: 'forced (manual trigger, gate bypassed)' }
    : decideTrigger(health, beforeCount);
  if (!trigger.shouldRun) {
    logger.info('Consolidation skipped', { reason: trigger.reason });
    return {
      triggered: false, applied: false, dryRun, reason: trigger.reason,
      before, after: before, actions: [], diff: 'Skipped — memory healthy.',
    };
  }

  // Ask the quick model for a compress-without-loss plan.
  const prompt = `${CONSOLIDATION_PROMPT}\n\n记忆文件：\n${buildFilesDump(files)}`;
  let planRaw: string;
  try {
    const result = await withTimeout(
      quickTask(prompt, MEMORY_CONSOLIDATION.MAX_TOKENS),
      MEMORY_CONSOLIDATION.TIMEOUT_MS,
      'Consolidation LLM timed out',
    );
    if (!result.success || !result.content) {
      return {
        triggered: true, applied: false, dryRun, reason: trigger.reason,
        before, after: before, actions: [], diff: 'LLM call failed.',
        error: result.error ?? 'quick model unavailable',
      };
    }
    planRaw = result.content;
  } catch (error) {
    return {
      triggered: true, applied: false, dryRun, reason: trigger.reason,
      before, after: before, actions: [], diff: 'LLM call errored.',
      error: String(error),
    };
  }

  const knownFilenames = new Set(files.map((f) => f.filename));
  const parsedPlan = parsePlan(planRaw, knownFilenames);
  if (!parsedPlan) {
    return {
      triggered: true, applied: false, dryRun, reason: trigger.reason,
      before, after: before, actions: [], diff: 'Plan unparsable.',
      error: `unparsable plan: ${planRaw.slice(0, 160)}`,
    };
  }

  // Safety: drop standalone deletes not backed by a merge (information-loss guard).
  const { actions: validatedActions, rejected } = validatePlan(parsedPlan.actions);
  if (rejected.length > 0) {
    logger.warn('Consolidation rejected unsafe standalone delete(s)', {
      rejected: rejected.flatMap((r) => r.sources),
    });
  }
  const plan = { actions: validatedActions };

  // Project the resulting file set: start from current files, add merge results, remove sources.
  const resultSet = new Set(files.map((f) => f.filename));
  for (const a of plan.actions) {
    if (a.kind === 'merge' && a.result) resultSet.add(`${a.result.filename}.md`);
  }
  for (const a of plan.actions) {
    for (const r of removedBy(a)) resultSet.delete(r);
  }
  const afterCount = resultSet.size;
  const netReduction = beforeCount - afterCount; // positive = files removed net
  let diff = buildDiff(plan.actions, beforeCount, afterCount);
  if (rejected.length > 0) {
    diff += `\n\nREJECTED (unsafe, not applied):\n`
      + rejected.map((r) => `  ${r.kind} ${r.sources.join(', ')} — ${r.reason}`).join('\n');
  }

  // Safety guard: a hallucinated plan should never nuke the store unattended.
  const maxRemovals = Math.max(3, Math.ceil(beforeCount * 0.5));
  if (netReduction > maxRemovals) {
    logger.warn('Consolidation blocked by safety guard', { netReduction, maxRemovals });
    return {
      triggered: true, applied: false, dryRun, reason: trigger.reason,
      before, after: { fileCount: afterCount, indexLineCount: health.indexLineCount },
      actions: plan.actions, diff,
      error: `safety guard: plan removes ${netReduction} files net (> ${maxRemovals}); not applied`,
    };
  }

  if (dryRun || plan.actions.length === 0) {
    logger.info('Consolidation dry-run / no-op', {
      dryRun, actionCount: plan.actions.length, netReduction,
    });
    return {
      triggered: true, applied: false, dryRun, reason: trigger.reason,
      before, after: { fileCount: afterCount, indexLineCount: health.indexLineCount },
      actions: plan.actions, diff,
    };
  }

  // Apply: write merge results, delete consumed sources, then rebuild INDEX.
  try {
    for (const action of plan.actions) {
      if (action.kind === 'merge' && action.result) {
        // Preserve frontmatter identity fields from the first source when the model omitted them.
        const first = await readMemoryFile(action.sources[0]);
        await writeLightMemoryFile({
          filename: action.result.filename,
          name: action.result.name,
          description: action.result.description || first?.description || action.result.name,
          type: action.result.type,
          content: action.result.content,
        });
      }
      for (const src of removedBy(action)) {
        await deleteMemoryFile(src);
      }
    }
    const rebuilt = await rebuildLightMemoryIndex();
    logger.info('Consolidation applied', {
      actions: plan.actions.length, netReduction, indexedFiles: rebuilt.indexedFiles,
    });
    return {
      triggered: true, applied: true, dryRun: false, reason: trigger.reason,
      before, after: { fileCount: rebuilt.indexedFiles, indexLineCount: rebuilt.indexedFiles + 3 },
      actions: plan.actions, diff,
    };
  } catch (error) {
    logger.error('Consolidation apply failed', { error });
    return {
      triggered: true, applied: false, dryRun: false, reason: trigger.reason,
      before, after: { fileCount: afterCount, indexLineCount: health.indexLineCount },
      actions: plan.actions, diff, error: String(error),
    };
  }
}
