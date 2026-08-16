import { getDatabase } from '../core/databaseService';
import { SKILL_REVIEW } from '../../../shared/constants';

function getDb() {
  return getDatabase().getDb();
}

export interface DistillSignalRecordResult {
  distinctSessionCount: number;
  inserted: boolean;
}

export type DistilledSkillStatus = 'active' | 'split_pending' | 'retired' | 'merged';
export type DistilledSkillVoteOutcome = 'adopted' | 'skipped' | 'negative_feedback';
export type DistilledSkillLifecycleAction = 'keep' | 'split' | 'retire' | 'merge';

export interface DistilledSkillLifecycleRecord {
  skillName: string;
  patternKey: string;
  status: DistilledSkillStatus;
  initialPositiveEvidence: number;
  importanceCount: number;
  promotedAt: number;
  updatedAt: number;
  retiredAt?: number;
  mergedInto?: string;
}

export interface DistilledSkillTaskBucket {
  taskClass: string;
  positive: number;
  negative: number;
  net: number;
}

export interface DistilledSkillVoteResult {
  record: DistilledSkillLifecycleRecord;
  action: DistilledSkillLifecycleAction;
  buckets: DistilledSkillTaskBucket[];
  changed: boolean;
}

interface DistilledSkillLifecycleRow {
  skill_name: string;
  pattern_key: string;
  status: DistilledSkillStatus;
  initial_positive_evidence: number;
  importance_count: number;
  promoted_at: number;
  updated_at: number;
  retired_at: number | null;
  merged_into: string | null;
}

function toLifecycleRecord(row: DistilledSkillLifecycleRow): DistilledSkillLifecycleRecord {
  return {
    skillName: row.skill_name,
    patternKey: row.pattern_key,
    status: row.status,
    initialPositiveEvidence: row.initial_positive_evidence,
    importanceCount: row.importance_count,
    promotedAt: row.promoted_at,
    updatedAt: row.updated_at,
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    ...(row.merged_into === null ? {} : { mergedInto: row.merged_into }),
  };
}

function normalizeTaskClass(taskClass: string | undefined): string {
  const normalized = taskClass?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized?.slice(0, 80) || 'unknown';
}

export function getSkillPromotionEvidenceThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[SKILL_REVIEW.PROMOTION_EVIDENCE_ENV];
  if (!raw) return SKILL_REVIEW.MIN_POSITIVE_USAGE_EVIDENCE;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : SKILL_REVIEW.MIN_POSITIVE_USAGE_EVIDENCE;
}

export function getDistillPositiveEvidenceCount(patternKey: string): number | null {
  const db = getDb();
  if (!db) return null;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS count
    FROM distill_signals
    WHERE pattern_key = ?
  `).get(patternKey) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function registerDistilledSkillPromotion(input: {
  skillName: string;
  patternKey: string;
  promotedAt?: number;
}): DistilledSkillLifecycleRecord | null {
  const db = getDb();
  if (!db) return null;
  const positiveEvidence = getDistillPositiveEvidenceCount(input.patternKey);
  if (
    positiveEvidence === null
    || positiveEvidence < getSkillPromotionEvidenceThreshold()
  ) return null;

  const now = input.promotedAt ?? Date.now();
  db.prepare(`
    INSERT INTO distill_skill_lifecycle (
      skill_name, pattern_key, status, initial_positive_evidence,
      importance_count, promoted_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT(skill_name) DO UPDATE SET
      pattern_key = excluded.pattern_key,
      updated_at = excluded.updated_at
  `).run(
    input.skillName,
    input.patternKey,
    positiveEvidence,
    positiveEvidence,
    now,
    now,
  );
  return getDistilledSkillLifecycle(input.skillName);
}

export function getDistilledSkillLifecycle(skillName: string): DistilledSkillLifecycleRecord | null {
  const db = getDb();
  if (!db) return null;
  const row = db.prepare(`
    SELECT * FROM distill_skill_lifecycle WHERE skill_name = ?
  `).get(skillName) as DistilledSkillLifecycleRow | undefined;
  return row ? toLifecycleRecord(row) : null;
}

function getTaskBuckets(skillName: string): DistilledSkillTaskBucket[] {
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare(`
    SELECT
      task_class,
      SUM(CASE WHEN delta = 1 THEN 1 ELSE 0 END) AS positive,
      SUM(CASE WHEN delta = -1 THEN 1 ELSE 0 END) AS negative,
      SUM(delta) AS net
    FROM distill_skill_votes
    WHERE skill_name = ?
    GROUP BY task_class
    ORDER BY task_class ASC
  `).all(skillName) as Array<{
    task_class: string;
    positive: number;
    negative: number;
    net: number;
  }>;
  return rows.map((row) => ({
    taskClass: row.task_class,
    positive: row.positive,
    negative: row.negative,
    net: row.net,
  }));
}

/** Assay 顺序：先识别跨任务类异质性，再判断退役，最后才允许合并。 */
export function decideDistilledSkillLifecycle(input: {
  status?: DistilledSkillStatus;
  importanceCount: number;
  buckets: DistilledSkillTaskBucket[];
  mergeCandidate?: string;
}): DistilledSkillLifecycleAction {
  if (input.status === 'split_pending') return 'split';
  if (input.status === 'retired' || input.status === 'merged') return 'keep';

  const hasPositiveClass = input.buckets.some((bucket) => bucket.net > 0);
  const hasNegativeClass = input.buckets.some((bucket) => bucket.net < 0);
  if (hasPositiveClass && hasNegativeClass) return 'split';
  if (input.importanceCount <= 0) return 'retire';
  if (input.mergeCandidate) return 'merge';
  return 'keep';
}

export function recordDistilledSkillVote(input: {
  skillName: string;
  eventKey: string;
  outcome: DistilledSkillVoteOutcome;
  taskClass?: string;
  sessionId?: string;
  createdAt?: number;
}): DistilledSkillVoteResult | null {
  const db = getDb();
  if (!db || !input.eventKey.trim()) return null;
  const now = input.createdAt ?? Date.now();
  const taskClass = normalizeTaskClass(input.taskClass);
  const delta = input.outcome === 'adopted' ? 1 : -1;

  return db.transaction(() => {
    const before = getDistilledSkillLifecycle(input.skillName);
    if (!before) return null;
    if (before.status === 'retired' || before.status === 'merged') {
      return { record: before, action: 'keep' as const, buckets: getTaskBuckets(input.skillName), changed: false };
    }

    const existing = db.prepare(`
      SELECT delta, outcome, task_class
      FROM distill_skill_votes
      WHERE skill_name = ? AND event_key = ?
    `).get(input.skillName, input.eventKey) as {
      delta: number;
      outcome: DistilledSkillVoteOutcome;
      task_class: string;
    } | undefined;

    if (
      existing?.delta === delta
      && existing.outcome === input.outcome
      && existing.task_class === taskClass
    ) {
      return { record: before, action: decideDistilledSkillLifecycle({
        status: before.status,
        importanceCount: before.importanceCount,
        buckets: getTaskBuckets(input.skillName),
      }), buckets: getTaskBuckets(input.skillName), changed: false };
    }

    db.prepare(`
      INSERT INTO distill_skill_votes (
        skill_name, event_key, session_id, task_class, outcome, delta, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_name, event_key) DO UPDATE SET
        session_id = excluded.session_id,
        task_class = excluded.task_class,
        outcome = excluded.outcome,
        delta = excluded.delta,
        created_at = excluded.created_at
    `).run(
      input.skillName,
      input.eventKey,
      input.sessionId ?? null,
      taskClass,
      input.outcome,
      delta,
      now,
    );

    const importanceCount = Math.max(0, before.importanceCount + delta - (existing?.delta ?? 0));
    const buckets = getTaskBuckets(input.skillName);
    const action = decideDistilledSkillLifecycle({
      status: before.status,
      importanceCount,
      buckets,
    });
    const status: DistilledSkillStatus = action === 'split'
      ? 'split_pending'
      : action === 'retire'
        ? 'retired'
        : before.status;
    db.prepare(`
      UPDATE distill_skill_lifecycle
      SET status = ?, importance_count = ?, updated_at = ?,
          retired_at = CASE WHEN ? = 'retired' THEN ? ELSE retired_at END
      WHERE skill_name = ?
    `).run(status, importanceCount, now, status, now, input.skillName);

    const record = getDistilledSkillLifecycle(input.skillName);
    return record ? { record, action, buckets, changed: true } : null;
  })();
}

export function markDistilledSkillTurnSignal(input: {
  turnId: string;
  skillName: string;
  kind: 'selected' | 'adopted';
  sessionId?: string;
  taskClass?: string;
  createdAt?: number;
}): boolean {
  const db = getDb();
  if (!db || !input.turnId.trim()) return false;
  const selected = input.kind === 'selected' ? 1 : 0;
  const adopted = input.kind === 'adopted' ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO distill_skill_turn_signals (
      turn_id, skill_name, session_id, task_class, selected, adopted, created_at
    )
    SELECT ?, skill_name, ?, ?, ?, ?, ?
    FROM distill_skill_lifecycle
    WHERE skill_name = ? AND status IN ('active', 'split_pending')
    ON CONFLICT(turn_id, skill_name) DO UPDATE SET
      session_id = COALESCE(excluded.session_id, distill_skill_turn_signals.session_id),
      task_class = CASE
        WHEN excluded.task_class = 'unknown' THEN distill_skill_turn_signals.task_class
        ELSE excluded.task_class
      END,
      selected = MAX(distill_skill_turn_signals.selected, excluded.selected),
      adopted = MAX(distill_skill_turn_signals.adopted, excluded.adopted)
  `).run(
    input.turnId,
    input.sessionId ?? null,
    normalizeTaskClass(input.taskClass),
    selected,
    adopted,
    input.createdAt ?? Date.now(),
    input.skillName,
  );
  return result.changes > 0;
}

export function finalizeDistilledSkillTurn(input: {
  turnId: string;
  taskClass?: string;
  createdAt?: number;
}): DistilledSkillVoteResult[] {
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare(`
    SELECT skill_name, session_id, task_class, adopted
    FROM distill_skill_turn_signals
    WHERE turn_id = ?
    ORDER BY skill_name ASC
  `).all(input.turnId) as Array<{
    skill_name: string;
    session_id: string | null;
    task_class: string;
    adopted: number;
  }>;
  const results: DistilledSkillVoteResult[] = [];
  for (const row of rows) {
    const result = recordDistilledSkillVote({
      skillName: row.skill_name,
      eventKey: `turn:${input.turnId}`,
      outcome: row.adopted ? 'adopted' : 'skipped',
      taskClass: input.taskClass ?? row.task_class,
      sessionId: row.session_id ?? undefined,
      createdAt: input.createdAt,
    });
    if (result) results.push(result);
  }
  db.prepare('DELETE FROM distill_skill_turn_signals WHERE turn_id = ?').run(input.turnId);
  return results;
}

export function requestDistilledSkillMerge(input: {
  skillName: string;
  mergeInto: string;
  requestedAt?: number;
}): DistilledSkillVoteResult | null {
  const db = getDb();
  if (!db || input.skillName === input.mergeInto) return null;
  const record = getDistilledSkillLifecycle(input.skillName);
  if (!record) return null;
  const buckets = getTaskBuckets(input.skillName);
  const action = decideDistilledSkillLifecycle({
    status: record.status,
    importanceCount: record.importanceCount,
    buckets,
    mergeCandidate: input.mergeInto,
  });
  if (action !== 'merge') return { record, action, buckets, changed: false };

  const now = input.requestedAt ?? Date.now();
  db.prepare(`
    UPDATE distill_skill_lifecycle
    SET status = 'merged', merged_into = ?, updated_at = ?
    WHERE skill_name = ?
  `).run(input.mergeInto, now, input.skillName);
  const updated = getDistilledSkillLifecycle(input.skillName);
  return updated ? { record: updated, action, buckets, changed: true } : null;
}

/** Persist one signal per pattern/session and return its distinct-session frequency. */
export function recordDistillSignal(input: {
  patternKey: string;
  sessionId: string;
  createdAt?: number;
}): DistillSignalRecordResult | null {
  const db = getDb();
  if (!db) return null;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO distill_signals (pattern_key, session_id, created_at)
    VALUES (?, ?, ?)
  `).run(input.patternKey, input.sessionId, input.createdAt ?? Date.now());

  const row = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS count
    FROM distill_signals
    WHERE pattern_key = ?
  `).get(input.patternKey) as { count: number } | undefined;
  return {
    distinctSessionCount: row?.count ?? 0,
    inserted: insert.changes > 0,
  };
}

export function hasDistillSuggestionForSession(sessionId: string): boolean {
  const db = getDb();
  if (!db) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM distill_suggestions WHERE session_id = ? LIMIT 1
  `).get(sessionId));
}

export function recordDistillSuggestion(input: {
  id: string;
  patternKey: string;
  sessionId: string;
  createdAt?: number;
}): void {
  const db = getDb();
  if (!db) return;
  db.prepare(`
    INSERT OR IGNORE INTO distill_suggestions (id, pattern_key, session_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(input.id, input.patternKey, input.sessionId, input.createdAt ?? Date.now());
}
