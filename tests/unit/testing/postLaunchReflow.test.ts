import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import {
  getPostLaunchConsentScope,
  hasReflowCandidate,
  listReflowCandidates,
  setPostLaunchConsentScope,
} from '../../../src/host/testing/postlaunch/postLaunchScoreStore';
import { checkPostLaunchReflowGates } from '../../../src/host/testing/postlaunch/postLaunchReflowGate';
import { applyPostLaunchReflowProvenance, scopeReplayToCandidate } from '@internal-evaluation/host/evaluation/harvestPreview';
import { deriveHarvestSeed } from '@internal-evaluation/host/evaluation/harvestCandidates';
import type { ReplayBlock, ReplayTurn, StructuredReplay } from '../../../src/shared/contract/evaluation';
import type { PostLaunchReflowCandidate } from '../../../src/shared/contract/postLaunchScore';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const VERSION = 'postlaunch-judge-v1';
const WORKDIR = '/tmp/reflow-harvest';
const FIRST_TURN_PROMPT = 'FEATURE_A_FIRST_TURN_PROMPT';
const TRIGGER_TURN_PROMPT = 'FEATURE_B_TRIGGER_TURN_PROMPT';
const FIRST_TURN_PATH = 'first-turn-secret.txt';
const FIRST_TURN_COMMAND = 'first-turn-secret-cmd';
const TRIGGER_TURN_PATH = 'trigger-turn.txt';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db, LOGGER);
  applyTelemetrySchema(db, LOGGER);
  return db;
}

function score(
  db: Database.Database,
  sessionId: string,
  turnId: string,
  dims: Record<string, number | null>,
  signals = '[]',
  scoredAt = 1,
) {
  db.prepare(`
    INSERT INTO telemetry_turn_scores
      (turn_id, session_id, scored_at, scored_day, turn_started_at, judge_version, rubric_version,
       dim_goal, dim_orchestration, dim_tools, dim_permission, dim_safety, dim_artifact,
       failure_class, signals, sampled_by)
    VALUES (?, ?, ?, '2026-09-06', ?, ?, 'postlaunch-rubric-v1', ?, ?, ?, ?, ?, ?, NULL, ?, 'signal')
  `).run(
    turnId, sessionId, scoredAt, scoredAt, VERSION,
    dims.goal, dims.orchestration, dims.tools, dims.permission, dims.safety, dims.artifact, signals,
  );
}

function redDims(): Record<string, number | null> {
  return { goal: 0, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 };
}

function toolBlock(name: string, category: 'Write' | 'Bash', args: Record<string, unknown>, timestamp: number): ReplayBlock {
  return {
    type: 'tool_call',
    content: name,
    timestamp,
    toolCall: { id: `call-${name}-${timestamp}`, name, args, success: true, duration: 1, category },
  };
}

function twoTurnReplay(): StructuredReplay {
  const first: ReplayTurn = {
    turnNumber: 1,
    blocks: [
      { type: 'user', content: FIRST_TURN_PROMPT, timestamp: 0 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${FIRST_TURN_PATH}` }, 1),
      toolBlock('Bash', 'Bash', { command: FIRST_TURN_COMMAND }, 2),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 1000,
  };
  const trigger: ReplayTurn = {
    turnNumber: 2,
    blocks: [
      { type: 'user', content: TRIGGER_TURN_PROMPT, timestamp: 3 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${TRIGGER_TURN_PATH}` }, 4),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 2000,
  };
  return {
    sessionId: 'sess-reflow-0001',
    traceIdentity: {
      traceId: 'session:sess-reflow-0001',
      traceSource: 'session_replay',
      source: 'session_replay',
      sessionId: 'sess-reflow-0001',
      replayKey: 'sess-reflow-0001',
    },
    traceSource: 'session_replay',
    dataSource: 'telemetry',
    turns: [first, trigger],
    summary: {
      totalTurns: 2,
      toolDistribution: { Read: 0, Edit: 0, Write: 2, Bash: 1, Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0 },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 2,
    },
  };
}

function triggerCandidate(): PostLaunchReflowCandidate {
  return {
    sessionId: 'sess-reflow-0001',
    turnId: '2',
    judgeVersion: VERSION,
    redDimensions: ['goal'],
    signals: [],
    failureClass: null,
    sources: ['judge'],
    occurredAt: 2000,
  };
}

function seedFrom(replay: StructuredReplay) {
  return deriveHarvestSeed({
    replay,
    sessionTitle: '回流草稿',
    workingDirectory: WORKDIR,
    fields: ['prompt', 'sourceSessionId'],
    batchTag: 'harvest-0907',
    negativeFeedbackAt: [],
  });
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
    expect(enriched.description).toContain('上线后回流触发');
    expect(enriched.description).toContain('source:judge');
    expect(enriched.description).toContain('red:goal');
    expect(enriched.postLaunchReflow).toMatchObject({ turnId: 't', sources: ['judge', 'signal'] });
  });

  it('turn_excerpt 题面只含触发轮原话、不含首轮原文和首轮工具参数；full_session 覆盖整会话', () => {
    const replay = twoTurnReplay();
    const candidates = [triggerCandidate()];
    const excerpt = seedFrom(scopeReplayToCandidate(replay, candidates, 'turn_excerpt'));
    expect(excerpt.prompt).toContain(TRIGGER_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(FIRST_TURN_PROMPT);
    const excerptBlob = JSON.stringify(excerpt.candidates);
    expect(excerptBlob).toContain(TRIGGER_TURN_PATH);
    expect(excerptBlob).not.toContain(FIRST_TURN_PATH);
    expect(excerptBlob).not.toContain(FIRST_TURN_COMMAND);

    const full = seedFrom(scopeReplayToCandidate(replay, candidates, 'full_session'));
    expect(full.prompt).toContain(FIRST_TURN_PROMPT);
    const fullBlob = JSON.stringify(full.candidates);
    expect(fullBlob).toContain(FIRST_TURN_PATH);
    expect(fullBlob).toContain('"tool":"Bash"');
    expect(fullBlob).toContain(TRIGGER_TURN_PATH);
  });

  it('200 条评分候选 + 1 条新点踩：点踩出现在默认限量结果里，且存在性检查为 true', () => {
    for (let index = 0; index < 200; index += 1) {
      score(db, `score-${index}`, `t-${index}`, redDims(), '[]', index + 1);
    }
    db.prepare(`INSERT INTO telemetry_feedback (id, session_id, turn_id, rating, created_at) VALUES ('f-new', 'thumbs-down', 't-down', -1, 10_000)`).run();

    const listed = listReflowCandidates(db);
    expect(listed).toHaveLength(200);
    expect(listed.some((candidate) => candidate.sessionId === 'thumbs-down')).toBe(true);
    expect(listed[0]?.sessionId).toBe('thumbs-down');
    expect(hasReflowCandidate(db, { sessionId: 'thumbs-down' })).toBe(true);
    expect(hasReflowCandidate(db, { sessionId: 'thumbs-down', turnId: 't-down' })).toBe(true);
  });

  it('超过 500 条评分候选时，被截断列表挤掉的会话存在性检查仍为 true', () => {
    for (let index = 0; index < 501; index += 1) {
      score(db, `old-${index}`, `turn-${index}`, redDims(), '[]', index + 1);
    }
    expect(listReflowCandidates(db, { limit: 500 })).toHaveLength(500);
    expect(listReflowCandidates(db, { limit: 500 }).some((candidate) => candidate.sessionId === 'old-0')).toBe(false);
    expect(hasReflowCandidate(db, { sessionId: 'old-0' })).toBe(true);
    expect(hasReflowCandidate(db, { sessionId: 'old-0', turnId: 'turn-0' })).toBe(true);
    expect(hasReflowCandidate(db, { sessionId: 'old-500', turnId: 'turn-500' })).toBe(true);
  });
});
