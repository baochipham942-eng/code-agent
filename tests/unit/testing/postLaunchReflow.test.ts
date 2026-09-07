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
import { applyPostLaunchReflowProvenance, pickTriggerCandidate, REFLOW_TURN_MISMATCH_MESSAGE, scopeReplayToCandidate } from '@internal-evaluation/host/evaluation/harvestPreview';
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
const FIRST_TURN_ID = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const TRIGGER_TURN_ID = '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d';
const ITERATION_ONE_TURN_ID = '8b9c0d1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e';
const ITERATION_TWO_TURN_ID = '9c0d1e2f-3a4b-5c6d-8e7f-6a5b4c3d2e1f';
const LATER_TURN_ID = 'ad1e2f3a-4b5c-6d7e-9f8a-7b6c5d4e3f2a';
const UNKNOWN_TURN_ID = '00000000-0000-4000-8000-000000000099';
/** assistant message.id 形态：UUID，但不在 telemetry_turns 里。 */
const FEEDBACK_MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const ITERATION_TURN_PATH = 'iter-turn.txt';
const ITERATION_TURN_COMMAND = 'iter-secret-cmd';
const LATER_TURN_PROMPT = 'FEATURE_C_LATER_TURN_PROMPT';
const LATER_TURN_PATH = 'later-turn.txt';

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
    turnId: TRIGGER_TURN_ID,
    judgeVersion: VERSION,
    redDimensions: ['goal'],
    signals: [],
    failureClass: null,
    sources: ['judge'],
    occurredAt: 2000,
  };
}

function triggerTurnRows() {
  return [
    { id: FIRST_TURN_ID, turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
    { id: TRIGGER_TURN_ID, turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
  ];
}

function feedbackCandidate(): PostLaunchReflowCandidate {
  return {
    sessionId: 'sess-reflow-0001',
    turnId: FEEDBACK_MESSAGE_ID,
    judgeVersion: null,
    redDimensions: [],
    signals: [],
    failureClass: null,
    sources: ['feedback'],
    feedbackId: 'fb-thumbs-down',
    messageId: FEEDBACK_MESSAGE_ID,
    feedbackAt: 2500,
    occurredAt: 2500,
  };
}

function threeTurnReplay(): StructuredReplay {
  const first: ReplayTurn = {
    turnNumber: 1,
    blocks: [
      { type: 'user', content: FIRST_TURN_PROMPT, timestamp: 0 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${FIRST_TURN_PATH}` }, 1),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 1000,
  };
  const second: ReplayTurn = {
    turnNumber: 2,
    blocks: [
      { type: 'user', content: TRIGGER_TURN_PROMPT, timestamp: 3 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${TRIGGER_TURN_PATH}` }, 4),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 2000,
  };
  const third: ReplayTurn = {
    turnNumber: 3,
    blocks: [
      { type: 'user', content: LATER_TURN_PROMPT, timestamp: 6 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${LATER_TURN_PATH}` }, 7),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 3000,
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
    turns: [first, second, third],
    summary: {
      totalTurns: 3,
      toolDistribution: { Read: 0, Edit: 0, Write: 3, Bash: 0, Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0 },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 3,
    },
  };
}

function threeTurnRows() {
  return [
    { id: FIRST_TURN_ID, turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
    { id: TRIGGER_TURN_ID, turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
    { id: LATER_TURN_ID, turn_number: 3, start_time: 3000, turn_type: 'user', parent_turn_id: null },
  ];
}

function firstTurnMessages() {
  return [
    { id: 'user-1', timestamp: 1000 },
    { id: FEEDBACK_MESSAGE_ID, timestamp: 1100 },
    { id: 'user-2', timestamp: 2000 },
    { id: 'asst-2', timestamp: 2100 },
    { id: 'user-3', timestamp: 3000 },
    { id: 'asst-3', timestamp: 3100 },
  ];
}

function iterationReplay(): StructuredReplay {
  const first: ReplayTurn = {
    turnNumber: 1,
    turnType: 'user',
    blocks: [
      { type: 'user', content: FIRST_TURN_PROMPT, timestamp: 0 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${FIRST_TURN_PATH}` }, 1),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 1000,
  };
  const parent: ReplayTurn = {
    turnNumber: 2,
    turnType: 'user',
    blocks: [
      { type: 'user', content: TRIGGER_TURN_PROMPT, timestamp: 3 },
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 2000,
  };
  const iterationOne: ReplayTurn = {
    turnNumber: 3,
    turnType: 'iteration',
    parentTurnId: TRIGGER_TURN_ID,
    blocks: [
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${ITERATION_TURN_PATH}` }, 4),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 2100,
  };
  const iterationTwo: ReplayTurn = {
    turnNumber: 4,
    turnType: 'iteration',
    parentTurnId: TRIGGER_TURN_ID,
    blocks: [
      toolBlock('Bash', 'Bash', { command: ITERATION_TURN_COMMAND }, 5),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 2200,
  };
  const later: ReplayTurn = {
    turnNumber: 5,
    turnType: 'user',
    blocks: [
      { type: 'user', content: LATER_TURN_PROMPT, timestamp: 6 },
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/${LATER_TURN_PATH}` }, 7),
    ],
    inputTokens: 0, outputTokens: 0, durationMs: 1, startTime: 3000,
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
    turns: [first, parent, iterationOne, iterationTwo, later],
    summary: {
      totalTurns: 5,
      toolDistribution: { Read: 0, Edit: 0, Write: 3, Bash: 1, Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0 },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 5,
    },
  };
}

function iterationTurnRows() {
  return [
    { id: FIRST_TURN_ID, turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
    { id: TRIGGER_TURN_ID, turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
    { id: ITERATION_ONE_TURN_ID, turn_number: 3, start_time: 2100, turn_type: 'iteration', parent_turn_id: TRIGGER_TURN_ID },
    { id: ITERATION_TWO_TURN_ID, turn_number: 4, start_time: 2200, turn_type: 'iteration', parent_turn_id: TRIGGER_TURN_ID },
    { id: LATER_TURN_ID, turn_number: 5, start_time: 3000, turn_type: 'user', parent_turn_id: null },
  ];
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
    }], 'turn_excerpt');
    expect(enriched.tags).toEqual(expect.arrayContaining(['postlaunch', 'source:judge', 'red:goal', 'signal:timeout']));
    expect(enriched.description).toContain('上线后回流触发');
    expect(enriched.description).toContain('source:judge');
    expect(enriched.description).toContain('red:goal');
    expect(enriched.postLaunchReflow).toMatchObject({
      turnId: 't',
      sources: ['judge', 'signal'],
      consentScope: 'turn_excerpt',
    });
  });

  it('turn_excerpt 题面只含触发轮原话、不含首轮原文和首轮工具参数；full_session 覆盖整会话', () => {
    const replay = twoTurnReplay();
    const candidates = [triggerCandidate()];
    const excerpt = seedFrom(scopeReplayToCandidate(replay, candidates, 'turn_excerpt', triggerTurnRows()));
    expect(excerpt.prompt).toContain(TRIGGER_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(FIRST_TURN_PROMPT);
    const excerptBlob = JSON.stringify(excerpt.candidates);
    expect(excerptBlob).toContain(TRIGGER_TURN_PATH);
    expect(excerptBlob).not.toContain(FIRST_TURN_PATH);
    expect(excerptBlob).not.toContain(FIRST_TURN_COMMAND);

    const full = seedFrom(scopeReplayToCandidate(replay, candidates, 'full_session', triggerTurnRows()));
    expect(full.prompt).toContain(FIRST_TURN_PROMPT);
    const fullBlob = JSON.stringify(full.candidates);
    expect(fullBlob).toContain(FIRST_TURN_PATH);
    expect(fullBlob).toContain('"tool":"Bash"');
    expect(fullBlob).toContain(TRIGGER_TURN_PATH);
  });

  it('候选 turnId 用 telemetry_turns 真 id 对得上才裁剪；对不上抛错，不退回整场会话', () => {
    const replay = twoTurnReplay();
    const matched = scopeReplayToCandidate(replay, [triggerCandidate()], 'turn_excerpt', triggerTurnRows());
    expect(seedFrom(matched).prompt).toContain(TRIGGER_TURN_PROMPT);
    expect(seedFrom(matched).prompt).not.toContain(FIRST_TURN_PROMPT);

    expect(() => scopeReplayToCandidate(
      replay,
      [{ ...triggerCandidate(), turnId: UNKNOWN_TURN_ID }],
      'turn_excerpt',
      triggerTurnRows(),
    )).toThrow(REFLOW_TURN_MISMATCH_MESSAGE);

    expect(() => scopeReplayToCandidate(
      replay,
      [{ ...triggerCandidate(), turnId: '2' }],
      'turn_excerpt',
      triggerTurnRows(),
    )).toThrow(REFLOW_TURN_MISMATCH_MESSAGE);
  });

  it('点踩候选 turnId 是 message.id 时按 created_at 时间锚裁剪，题面是锚定轮原话', () => {
    const replay = twoTurnReplay();
    const excerpt = seedFrom(scopeReplayToCandidate(replay, [feedbackCandidate()], 'turn_excerpt', triggerTurnRows()));
    expect(excerpt.prompt).toBe(TRIGGER_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(FIRST_TURN_PROMPT);
    const excerptBlob = JSON.stringify(excerpt.candidates);
    expect(excerptBlob).toContain(TRIGGER_TURN_PATH);
    expect(excerptBlob).not.toContain(FIRST_TURN_PATH);
    expect(excerptBlob).not.toContain(FIRST_TURN_COMMAND);
  });

  it('三轮会话事后给第一轮补踩：按被评价消息自己的时间定轮，不锚到第三轮', () => {
    const lateFeedback: PostLaunchReflowCandidate = {
      ...feedbackCandidate(),
      feedbackAt: 4000,
      occurredAt: 4000,
    };
    const excerpt = seedFrom(scopeReplayToCandidate(
      threeTurnReplay(),
      [lateFeedback],
      'turn_excerpt',
      threeTurnRows(),
      firstTurnMessages(),
    ));
    expect(excerpt.prompt).toBe(FIRST_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(TRIGGER_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(LATER_TURN_PROMPT);
    const excerptBlob = JSON.stringify(excerpt.candidates);
    expect(excerptBlob).toContain(FIRST_TURN_PATH);
    expect(excerptBlob).not.toContain(TRIGGER_TURN_PATH);
    expect(excerptBlob).not.toContain(LATER_TURN_PATH);
  });

  it('点踩消息对不上时再退 created_at 时间锚', () => {
    const lateFeedback: PostLaunchReflowCandidate = {
      ...feedbackCandidate(),
      turnId: 'ghost-message',
      messageId: 'ghost-message',
      feedbackAt: 4000,
      occurredAt: 4000,
    };
    const excerpt = seedFrom(scopeReplayToCandidate(
      threeTurnReplay(),
      [lateFeedback],
      'turn_excerpt',
      threeTurnRows(),
      firstTurnMessages(),
    ));
    expect(excerpt.prompt).toBe(LATER_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(FIRST_TURN_PROMPT);
  });

  it('点踩候选缺 created_at 锚时仍 fail-closed，不把 message.id 当轮 id', () => {
    expect(() => scopeReplayToCandidate(
      twoTurnReplay(),
      [{ ...feedbackCandidate(), occurredAt: undefined, feedbackAt: undefined }],
      'turn_excerpt',
      triggerTurnRows(),
    )).toThrow(REFLOW_TURN_MISMATCH_MESSAGE);
  });

  it('评分候选 turnId 对不上仍 fail-closed，即使带了 occurredAt 也不走点踩时间锚', () => {
    expect(() => scopeReplayToCandidate(
      twoTurnReplay(),
      [{ ...triggerCandidate(), turnId: UNKNOWN_TURN_ID, occurredAt: 2500 }],
      'turn_excerpt',
      triggerTurnRows(),
    )).toThrow(REFLOW_TURN_MISMATCH_MESSAGE);
  });

  it('turn_excerpt 保留触发父轮的全部 iteration 子轮工具/文件，裁掉其他用户轮', () => {
    const scoped = scopeReplayToCandidate(
      iterationReplay(),
      [triggerCandidate()],
      'turn_excerpt',
      iterationTurnRows(),
    );
    const scopedBlob = JSON.stringify(scoped.turns);
    expect(scopedBlob).toContain(ITERATION_TURN_PATH);
    expect(scopedBlob).toContain(ITERATION_TURN_COMMAND);
    expect(scopedBlob).not.toContain(FIRST_TURN_PATH);
    expect(scopedBlob).not.toContain(LATER_TURN_PATH);
    expect(scopedBlob).not.toContain(LATER_TURN_PROMPT);

    const excerpt = seedFrom(scoped);
    expect(excerpt.prompt).toBe(TRIGGER_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(FIRST_TURN_PROMPT);
    expect(excerpt.prompt).not.toContain(LATER_TURN_PROMPT);
    const excerptBlob = JSON.stringify(excerpt.candidates);
    expect(excerptBlob).toContain(ITERATION_TURN_PATH);
    expect(excerptBlob).toContain('"tool":"Bash"');
    expect(excerptBlob).not.toContain(FIRST_TURN_PATH);
    expect(excerptBlob).not.toContain(LATER_TURN_PATH);
  });

  it('预览所用档高于当前档时拒，档不变或升高时放行', () => {
    score(db, 's', 't', { goal: 0, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 });
    setPostLaunchConsentScope(db, 's', 'full_session', 11);
    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's', turnId: 't', previewConsentScope: 'full_session',
    }).allowed).toBe(true);

    setPostLaunchConsentScope(db, 's', 'turn_excerpt', 12);
    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's', turnId: 't', previewConsentScope: 'full_session',
    })).toMatchObject({ allowed: false, reason: 'consent_stale' });
    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's', turnId: 't', previewConsentScope: 'turn_excerpt',
    }).allowed).toBe(true);

    setPostLaunchConsentScope(db, 's', 'full_session', 13);
    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's', turnId: 't', previewConsentScope: 'turn_excerpt',
    }).allowed).toBe(true);

    setPostLaunchConsentScope(db, 's', 'metadata', 14);
    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's', turnId: 't', previewConsentScope: 'full_session',
    })).toMatchObject({ allowed: false, reason: 'consent_required' });
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

  it('多候选会话裁剪/溯源/保存绑同一条：点踩撤销后必拒，tags 不含旧评分轮信号', () => {
    score(db, 's', 'turn-A', redDims(), '["timeout"]', 1);
    db.prepare(`
      INSERT INTO telemetry_feedback (id, session_id, turn_id, message_id, rating, created_at)
      VALUES ('fb-down', 's', NULL, NULL, -1, 10)
    `).run();
    setPostLaunchConsentScope(db, 's', 'turn_excerpt', 11);

    const listed = listReflowCandidates(db, { sessionId: 's' });
    const trigger = pickTriggerCandidate(listed, 's');
    expect(trigger?.sources).toEqual(['feedback']);
    expect(trigger?.feedbackId).toBe('fb-down');
    expect(trigger?.turnId).toBeNull();

    const seed = applyPostLaunchReflowProvenance({
      sessionId: 's', sessionTitle: 'title', id: 'draft-s', prompt: 'p', description: 'd', tags: [], candidates: [], notes: [],
    }, listed, 'turn_excerpt');
    expect(seed.tags).toEqual(expect.arrayContaining(['postlaunch', 'source:feedback']));
    expect(seed.tags).not.toContain('source:judge');
    expect(seed.tags).not.toContain('red:goal');
    expect(seed.tags).not.toContain('signal:timeout');
    expect(seed.postLaunchReflow).toMatchObject({
      turnId: null,
      feedbackId: 'fb-down',
      sources: ['feedback'],
    });

    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's',
      turnId: seed.postLaunchReflow?.turnId ?? null,
      feedbackId: seed.postLaunchReflow?.feedbackId,
    }).allowed).toBe(true);

    db.prepare('DELETE FROM telemetry_feedback WHERE id = ?').run('fb-down');
    expect(checkPostLaunchReflowGates(db, {
      sessionId: 's',
      turnId: seed.postLaunchReflow?.turnId ?? null,
      feedbackId: seed.postLaunchReflow?.feedbackId,
    })).toMatchObject({ allowed: false, reason: 'not_candidate' });
    expect(checkPostLaunchReflowGates(db, { sessionId: 's', turnId: 'turn-A' }).allowed).toBe(true);
  });

  it('同一会话两条裸点踩（turn_id 空、message_id 不同）各自成候选，锚点不串', () => {
    const sessionId = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
    const messageA = '550e8400-e29b-41d4-a716-4466554400aa';
    const messageB = '550e8400-e29b-41d4-a716-4466554400bb';
    const feedbackA = '6ba7b810-9dad-11d1-80b4-00c04fd430aa';
    const feedbackB = '6ba7b810-9dad-11d1-80b4-00c04fd430bb';
    db.prepare(`
      INSERT INTO telemetry_feedback (id, session_id, turn_id, message_id, rating, created_at)
      VALUES (?, ?, NULL, ?, -1, ?), (?, ?, NULL, ?, -1, ?)
    `).run(feedbackA, sessionId, messageA, 1_000, feedbackB, sessionId, messageB, 2_000);

    const listed = listReflowCandidates(db, { sessionId });
    expect(listed).toHaveLength(2);
    const byMessage = new Map(listed.map((candidate) => [candidate.messageId, candidate]));
    expect(byMessage.get(messageA)).toMatchObject({
      sessionId, turnId: null, feedbackId: feedbackA, messageId: messageA, feedbackAt: 1_000, occurredAt: 1_000,
    });
    expect(byMessage.get(messageB)).toMatchObject({
      sessionId, turnId: null, feedbackId: feedbackB, messageId: messageB, feedbackAt: 2_000, occurredAt: 2_000,
    });
  });

  it('一条裸点踩 + 一条绑轮点踩互不覆盖', () => {
    const sessionId = 'b2c3d4e5-f6a7-4890-9bcd-ef0123456789';
    const bareMessage = '550e8400-e29b-41d4-a716-4466554400cc';
    const boundTurn = TRIGGER_TURN_ID;
    const boundMessage = '550e8400-e29b-41d4-a716-4466554400dd';
    const bareFeedback = '6ba7b810-9dad-11d1-80b4-00c04fd430cc';
    const boundFeedback = '6ba7b810-9dad-11d1-80b4-00c04fd430dd';
    db.prepare(`
      INSERT INTO telemetry_feedback (id, session_id, turn_id, message_id, rating, created_at)
      VALUES (?, ?, NULL, ?, -1, ?), (?, ?, ?, ?, -1, ?)
    `).run(bareFeedback, sessionId, bareMessage, 1_000, boundFeedback, sessionId, boundTurn, boundMessage, 2_000);

    const listed = listReflowCandidates(db, { sessionId });
    expect(listed).toHaveLength(2);
    const bare = listed.find((candidate) => candidate.feedbackId === bareFeedback);
    const bound = listed.find((candidate) => candidate.feedbackId === boundFeedback);
    expect(bare).toMatchObject({
      sessionId, turnId: null, feedbackId: bareFeedback, messageId: bareMessage, feedbackAt: 1_000, occurredAt: 1_000,
    });
    expect(bound).toMatchObject({
      sessionId, turnId: boundTurn, feedbackId: boundFeedback, messageId: boundMessage, feedbackAt: 2_000, occurredAt: 2_000,
    });
  });

  it('同键合并锚点三件套取 created_at 最新那条，乱序插入也不拼字段', () => {
    const sessionId = 'c3d4e5f6-a7b8-4901-acde-f01234567890';
    const turnId = TRIGGER_TURN_ID;
    const oldMessage = '550e8400-e29b-41d4-a716-4466554400ee';
    const newMessage = '550e8400-e29b-41d4-a716-4466554400ff';
    const oldFeedback = '6ba7b810-9dad-11d1-80b4-00c04fd430ee';
    const newFeedback = '6ba7b810-9dad-11d1-80b4-00c04fd430ff';
    db.prepare(`
      INSERT INTO telemetry_feedback (id, session_id, turn_id, message_id, rating, created_at)
      VALUES (?, ?, ?, ?, -1, ?)
    `).run(newFeedback, sessionId, turnId, newMessage, 5_000);
    db.prepare(`
      INSERT INTO telemetry_feedback (id, session_id, turn_id, message_id, rating, created_at)
      VALUES (?, ?, ?, ?, -1, ?)
    `).run(oldFeedback, sessionId, turnId, oldMessage, 1_000);

    const listed = listReflowCandidates(db, { sessionId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      sessionId,
      turnId,
      feedbackId: newFeedback,
      messageId: newMessage,
      feedbackAt: 5_000,
      occurredAt: 5_000,
    });
  });
});
