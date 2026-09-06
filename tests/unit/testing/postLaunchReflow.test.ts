import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import {
  getPostLaunchConsentScope,
  listReflowCandidates,
  setPostLaunchConsentScope,
} from '../../../src/host/testing/postlaunch/postLaunchScoreStore';
import { checkPostLaunchReflowGates } from '../../../src/host/testing/postlaunch/postLaunchReflowGate';
import { applyPostLaunchReflowProvenance } from '@internal-evaluation/host/evaluation/harvestPreview';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const VERSION = 'postlaunch-judge-v1';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db, LOGGER);
  applyTelemetrySchema(db, LOGGER);
  return db;
}

function score(db: Database.Database, sessionId: string, turnId: string, dims: Record<string, number | null>, signals = '[]') {
  db.prepare(`
    INSERT INTO telemetry_turn_scores
      (turn_id, session_id, scored_at, scored_day, turn_started_at, judge_version, rubric_version,
       dim_goal, dim_orchestration, dim_tools, dim_permission, dim_safety, dim_artifact,
       failure_class, signals, sampled_by)
    VALUES (?, ?, 1, '2026-09-06', 1, ?, 'postlaunch-rubric-v1', ?, ?, ?, ?, ?, ?, NULL, ?, 'signal')
  `).run(turnId, sessionId, VERSION, dims.goal, dims.orchestration, dims.tools, dims.permission, dims.safety, dims.artifact, signals);
}

describe('post-launch reflow candidates and gates', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('收集 judge 红、确定性信号、点踩，排除全绿', () => {
    score(db, 'judge-red', 't1', { goal: 0, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 });
    score(db, 'signal', 't2', { goal: 1, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 }, '["timeout"]');
    score(db, 'green', 't3', { goal: 1, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 });
    db.prepare(`INSERT INTO telemetry_feedback (id, session_id, turn_id, rating, created_at) VALUES ('f1', 'feedback', NULL, -1, 2)`).run();

    const candidates = listReflowCandidates(db);
    expect(new Set(candidates.map((candidate) => candidate.sessionId))).toEqual(new Set(['signal', 'judge-red', 'feedback']));
    expect(candidates.find((candidate) => candidate.sessionId === 'judge-red')?.sources).toContain('judge');
    expect(candidates.find((candidate) => candidate.sessionId === 'signal')?.sources).toContain('signal');
    expect(candidates.find((candidate) => candidate.sessionId === 'feedback')?.sources).toContain('feedback');
    expect(candidates.some((candidate) => candidate.sessionId === 'green')).toBe(false);
  });

  it('默认 metadata 只留分数行；turn_excerpt 才放行草稿，full_session 可被读取', () => {
    score(db, 's', 't', { goal: 0, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 });
    expect(getPostLaunchConsentScope(db, 's')).toBe('metadata');
    expect(checkPostLaunchReflowGates(db, { sessionId: 's', turnId: 't' })).toMatchObject({ allowed: false, reason: 'consent_required' });
    setPostLaunchConsentScope(db, 's', 'turn_excerpt', 10);
    expect(checkPostLaunchReflowGates(db, { sessionId: 's', turnId: 't' }).allowed).toBe(true);
    setPostLaunchConsentScope(db, 's', 'full_session', 11);
    expect(getPostLaunchConsentScope(db, 's')).toBe('full_session');
  });

  it('HARVEST 草稿保留 postlaunch、源会话和触发信号溯源', () => {
    const seed = {
      sessionId: 's', sessionTitle: 'title', id: 'draft-s', prompt: 'p', description: 'd', tags: [], candidates: [], notes: [],
    };
    const enriched = applyPostLaunchReflowProvenance(seed, [{
      sessionId: 's', turnId: 't', judgeVersion: VERSION, redDimensions: ['goal'], signals: ['timeout'],
      failureClass: 'timeout', sources: ['judge', 'signal'],
    }]);
    expect(enriched.tags).toEqual(expect.arrayContaining(['postlaunch', 'source:judge', 'red:goal', 'signal:timeout']));
    expect(enriched.postLaunchReflow).toMatchObject({ turnId: 't', sources: ['judge', 'signal'] });
  });
});
