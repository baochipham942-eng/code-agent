import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HarvestFieldKey,
  ReplayBlock,
  ReplayToolCategory,
  ReplayTurn,
  StructuredReplay,
} from '../../../src/shared/contract/evaluation';

const WORKDIR = '/tmp/harvest-workspace';

const db = vi.hoisted(() => ({
  replay: vi.fn(),
  session: vi.fn(),
  feedback: vi.fn(),
  messages: vi.fn(() => [] as Array<{ id: string; timestamp: number }>),
  turns: vi.fn(() => [] as Array<{
    id: string;
    turn_number: number;
    start_time: number;
    turn_type: string;
    parent_turn_id: string | null;
  }>),
}));

const reflowStore = vi.hoisted(() => ({
  list: vi.fn(() => [] as Array<{
    sessionId: string;
    turnId: string | null;
    judgeVersion: string | null;
    redDimensions: string[];
    signals: string[];
    failureClass: string | null;
    sources: Array<'judge' | 'signal' | 'feedback'>;
    occurredAt?: number;
    feedbackAt?: number;
    feedbackId?: string;
    messageId?: string | null;
  }>),
  consent: vi.fn(() => 'turn_excerpt' as 'metadata' | 'turn_excerpt' | 'full_session'),
  enabled: true,
}));

// 宿主取数走真实入口 buildHarvestPreview，只把数据库与回放服务换成夹具
// （与 tests/unit/ipc/evaluationRunBridge.ipc.test.ts 同一套 mock 写法）。
vi.mock('@host/telemetry/replay/telemetryQueryService', () => ({
  getTelemetryQueryService: () => ({ getStructuredReplay: db.replay }),
}));

vi.mock('@host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: db.session,
    getMessages: db.messages,
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => (String(sql).includes('telemetry_turns') ? db.turns() : db.feedback()),
      }),
    }),
  }),
}));

vi.mock('@host/testing/postlaunch/postLaunchScoreStore', () => ({
  listReflowCandidates: reflowStore.list,
  getPostLaunchConsentScope: reflowStore.consent,
}));

vi.mock('@host/testing/postlaunch/postLaunchGate', () => ({
  isPostLaunchReflowEnabled: () => reflowStore.enabled,
}));

import { deriveHarvestSeed } from '@internal-evaluation/host/evaluation/harvestCandidates';
import { buildHarvestPreview } from '@internal-evaluation/host/evaluation/harvestPreview';

function toolBlock(
  name: string,
  category: ReplayToolCategory,
  args: Record<string, unknown>,
  timestamp = 1,
): ReplayBlock {
  return {
    type: 'tool_call',
    content: name,
    timestamp,
    toolCall: { id: `call-${name}-${timestamp}`, name, args, success: true, duration: 1, category },
  };
}

function userBlock(content: string, timestamp = 0): ReplayBlock {
  return { type: 'user', content, timestamp };
}

function turn(blocks: ReplayBlock[], startTime = 1000, turnNumber = 1): ReplayTurn {
  return { turnNumber, blocks, inputTokens: 0, outputTokens: 0, durationMs: 1, startTime };
}

function replay(turns: ReplayTurn[], grade?: 'excellent' | 'good' | 'watch' | 'risk'): StructuredReplay {
  return {
    sessionId: 'sess-fake-0001',
    traceIdentity: {
      traceId: 'session:sess-fake-0001',
      traceSource: 'session_replay',
      source: 'session_replay',
      sessionId: 'sess-fake-0001',
      replayKey: 'sess-fake-0001',
    },
    traceSource: 'session_replay',
    dataSource: 'telemetry',
    turns,
    summary: {
      totalTurns: turns.length,
      toolDistribution: { Read: 0, Edit: 0, Write: 0, Bash: 0, Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0 },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 1,
      ...(grade ? { qualityScore: { score: 1, max: 10, grade, breakdown: [] } } : {}),
    },
  };
}

const DEFAULT_FIELDS: HarvestFieldKey[] = ['prompt', 'sourceSessionId'];

function seedOf(turns: ReplayTurn[], options: {
  fields?: HarvestFieldKey[];
  negativeFeedbackAt?: number[];
  workingDirectory?: string;
  grade?: 'excellent' | 'good' | 'watch' | 'risk';
} = {}) {
  return deriveHarvestSeed({
    replay: replay(turns, options.grade),
    sessionTitle: '生成销售报告',
    workingDirectory: options.workingDirectory ?? WORKDIR,
    fields: options.fields ?? DEFAULT_FIELDS,
    batchTag: 'harvest-0904',
    negativeFeedbackAt: options.negativeFeedbackAt ?? [],
  });
}

describe('从会话推候选判定标准', () => {
  it('真阳：写文件出 file_exists（绝对路径转相对），调过的工具去重出 tool_called', () => {
    const seed = seedOf([turn([
      userBlock('生成一份报告'),
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/out/summary.html` }, 1),
      toolBlock('Write', 'Write', { file_path: `${WORKDIR}/out/summary.html` }, 2),
    ])]);

    expect(seed.candidates).toEqual([
      { type: 'file_exists', params: { path: 'out/summary.html' }, reason: '会话里写了 out/summary.html' },
      { type: 'tool_called', params: { tool: 'Write' }, reason: '会话里调用了 Write' },
    ]);
    expect(seed.notes).toEqual([]);
  });

  it('相对路径原样保留', () => {
    const seed = seedOf([turn([toolBlock('Write', 'Write', { file_path: 'out/summary.html' })])]);
    expect(seed.candidates[0]).toMatchObject({ type: 'file_exists', params: { path: 'out/summary.html' } });
  });

  it('真阴：零工具调用不出任何候选，给「需手动补一条」的提示', () => {
    const seed = seedOf([turn([userBlock('聊两句')])]);
    expect(seed.candidates).toEqual([]);
    expect(seed.notes).toContain('noCandidates');
  });

  it('真阴：越出工作区的绝对路径不出候选（只剩 tool_called）', () => {
    const seed = seedOf([turn([
      toolBlock('Write', 'Write', { file_path: '/etc/hosts' }),
      toolBlock('Edit', 'Edit', { file_path: `${WORKDIR}/../outside.txt` }),
    ])]);

    expect(seed.candidates.filter((candidate) => candidate.type === 'file_exists')).toEqual([]);
    expect(seed.candidates.map((candidate) => candidate.params.tool)).toEqual(['Write', 'Edit']);
  });

  it('真阴：工作目录未知时绝对路径不出候选', () => {
    const seed = seedOf(
      [turn([toolBlock('Write', 'Write', { file_path: '/var/log/x.txt' })])],
      { workingDirectory: '' },
    );
    expect(seed.candidates.filter((candidate) => candidate.type === 'file_exists')).toEqual([]);
  });

  it('点踩那轮含 Bash → command_succeeds 反向候选', () => {
    const seed = seedOf([
      turn([userBlock('跑一下检查')], 1000, 1),
      turn([toolBlock('Bash', 'Bash', { command: 'python3 check.py' }, 2001)], 2000, 2),
    ], { negativeFeedbackAt: [2500] });

    expect(seed.candidates).toContainEqual({
      type: 'command_succeeds',
      params: { command: 'python3 check.py' },
      reason: '点踩那轮的反向候选',
    });
    expect(seed.notes).not.toContain('negativeFeedbackNeedsManual');
  });

  it('点踩时刻早于所有轮次时回落第一轮（那一轮的 Bash 才是反向候选）', () => {
    const seed = seedOf([
      turn([toolBlock('Bash', 'Bash', { command: 'npm run first' }, 5001)], 5000, 1),
      turn([toolBlock('Bash', 'Bash', { command: 'npm run second' }, 6001)], 6000, 2),
    ], { negativeFeedbackAt: [100] });

    expect(seed.candidates).toContainEqual({
      type: 'command_succeeds',
      params: { command: 'npm run first' },
      reason: '点踩那轮的反向候选',
    });
  });

  it('点踩那轮推不出东西时只给提示，不编造候选', () => {
    const seed = seedOf([turn([userBlock('为什么这么慢')], 1000, 1)], { negativeFeedbackAt: [1500] });
    expect(seed.candidates).toEqual([]);
    expect(seed.notes).toEqual(['noCandidates', 'negativeFeedbackNeedsManual']);
  });
});

describe('草稿预填', () => {
  const turns = [turn([
    userBlock('在工作目录里读 sales.csv，生成 out/summary.html'),
    toolBlock('Write', 'Write', { file_path: `${WORKDIR}/out/summary.html` }),
  ])];

  it('勾上质量标记时带 quality-<grade> 标签；不勾就不带', () => {
    const withQuality = seedOf(turns, {
      grade: 'risk',
      fields: ['prompt', 'sourceSessionId', 'qualityTags'],
    });
    expect(withQuality.tags).toEqual(['harvest-0904', 'quality-risk']);
    expect(withQuality.id).toBe('draft-ake-0001');
    expect(withQuality.prompt).toBe('在工作目录里读 sales.csv，生成 out/summary.html');
    expect(withQuality.description).toBe('生成销售报告');

    expect(seedOf(turns, { grade: 'risk' }).tags).toEqual(['harvest-0904']);
  });

  it('工具调用序列默认不进描述，勾上后才作为背景写进描述', () => {
    expect(seedOf(turns).description).not.toContain('Write');
    expect(seedOf(turns, { fields: ['prompt', 'sourceSessionId', 'toolTrace'] }).description).toContain('Write');
  });
});

describe('预览编排', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T09:00:00'));
    db.feedback.mockReturnValue([]);
    db.turns.mockReturnValue([]);
    db.session.mockReturnValue({ title: '一场会话', workingDirectory: WORKDIR });
    db.replay.mockImplementation(async (sessionId: string) => (sessionId === 'sess-fake-0001'
      ? replay([turn([userBlock('干点活'), toolBlock('Write', 'Write', { file_path: 'out/a.txt' })])])
      : null));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    reflowStore.enabled = true;
    reflowStore.consent.mockReturnValue('turn_excerpt');
    reflowStore.list.mockReturnValue([]);
    db.turns.mockReturnValue([]);
    db.messages.mockReturnValue([]);
  });

  it('取不到内容的会话只进 failed，不炸整批；批次标签按当天日期', async () => {
    const result = await buildHarvestPreview({ sessionIds: ['sess-fake-0001', 'sess-fake-0002'], fields: ['prompt'] });

    expect(result.seeds).toHaveLength(1);
    expect(result.failed).toEqual([{ sessionId: 'sess-fake-0002', error: '这场会话没有可回放的记录' }]);
    expect(result.seeds[0].tags[0]).toBe('harvest-0904');
  });

  it('前端没传锁定行也照样带上来源会话（来源必须留）', async () => {
    const result = await buildHarvestPreview({ sessionIds: ['sess-fake-0001'], fields: [] });
    expect(result.seeds[0].sessionId).toBe('sess-fake-0001');
  });

  it('会话没有用户原话时进 failed，不出空题面的草稿', async () => {
    db.replay.mockResolvedValue(replay([turn([toolBlock('Write', 'Write', { file_path: 'out/a.txt' })])]));

    const result = await buildHarvestPreview({ sessionIds: ['sess-fake-0001'], fields: [] });
    expect(result.seeds).toEqual([]);
    expect(result.failed).toEqual([{ sessionId: 'sess-fake-0001', error: '这场会话没有可用的用户原话' }]);
  });

  it('一场都没选 / 超过上限时直接报错', async () => {
    await expect(buildHarvestPreview({ sessionIds: [], fields: [] })).rejects.toThrow('请先选择至少一场会话');
    await expect(buildHarvestPreview({
      sessionIds: Array.from({ length: 21 }, (_, index) => `sess-fake-${index}`),
      fields: [],
    })).rejects.toThrow('一次最多转换 20 场会话');
  });

  it('回流预览按同意档裁剪：turn_excerpt 不含首轮原文，full_session 覆盖整会话', async () => {
    const firstTurnPath = 'first-turn-secret.txt';
    const triggerPath = 'trigger-turn.txt';
    const firstTurnId = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
    const triggerTurnId = '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d';
    db.replay.mockResolvedValue(replay([
      turn([
        userBlock('FEATURE_A_FIRST_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: firstTurnPath }, 1),
      ], 1000, 1),
      turn([
        userBlock('FEATURE_B_TRIGGER_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: triggerPath }, 2),
      ], 2000, 2),
    ]));
    reflowStore.enabled = true;
    reflowStore.list.mockReturnValue([{
      sessionId: 'sess-fake-0001',
      turnId: triggerTurnId,
      judgeVersion: 'postlaunch-judge-v1',
      redDimensions: ['goal'],
      signals: [],
      failureClass: null,
      sources: ['judge'],
    }]);
    db.turns.mockReturnValue([
      { id: firstTurnId, turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
      { id: triggerTurnId, turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
    ]);

    reflowStore.consent.mockReturnValue('turn_excerpt');
    const excerpt = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(excerpt.failed).toEqual([]);
    expect(excerpt.seeds[0]?.prompt).toContain('FEATURE_B_TRIGGER_TURN_PROMPT');
    expect(excerpt.seeds[0]?.prompt).not.toContain('FEATURE_A_FIRST_TURN_PROMPT');
    expect(JSON.stringify(excerpt.seeds[0]?.candidates)).not.toContain(firstTurnPath);
    expect(JSON.stringify(excerpt.seeds[0]?.candidates)).toContain(triggerPath);
    expect(excerpt.seeds[0]?.postLaunchReflow).toMatchObject({
      turnId: triggerTurnId,
      consentScope: 'turn_excerpt',
    });

    reflowStore.consent.mockReturnValue('full_session');
    const full = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(full.seeds[0]?.prompt).toContain('FEATURE_A_FIRST_TURN_PROMPT');
    expect(JSON.stringify(full.seeds[0]?.candidates)).toContain(firstTurnPath);
    expect(JSON.stringify(full.seeds[0]?.candidates)).toContain(triggerPath);
    expect(full.seeds[0]?.postLaunchReflow?.consentScope).toBe('full_session');
  });

  it('候选 turnId 是 telemetry_turns 真 id 对不上回放时进 failed，不放行整场会话', async () => {
    db.replay.mockResolvedValue(replay([
      turn([userBlock('FEATURE_A_FIRST_TURN_PROMPT')], 1000, 1),
      turn([userBlock('FEATURE_B_TRIGGER_TURN_PROMPT')], 2000, 2),
    ]));
    reflowStore.enabled = true;
    reflowStore.consent.mockReturnValue('turn_excerpt');
    reflowStore.list.mockReturnValue([{
      sessionId: 'sess-fake-0001',
      turnId: '00000000-0000-4000-8000-000000000099',
      judgeVersion: 'postlaunch-judge-v1',
      redDimensions: ['goal'],
      signals: [],
      failureClass: null,
      sources: ['judge'],
    }]);
    db.turns.mockReturnValue([
      { id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
      { id: '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d', turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
    ]);

    const result = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(result.seeds).toEqual([]);
    expect(result.failed).toEqual([{
      sessionId: 'sess-fake-0001',
      error: '回流触发轮对不上回放记录',
    }]);
  });

  it('点踩候选 turnId 是 message.id 时按 created_at 预览出锚定轮原话，不进 failed', async () => {
    const messageId = '550e8400-e29b-41d4-a716-446655440000';
    db.replay.mockResolvedValue(replay([
      turn([
        userBlock('FEATURE_A_FIRST_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'first-turn-secret.txt' }, 1),
      ], 1000, 1),
      turn([
        userBlock('FEATURE_B_TRIGGER_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'trigger-turn.txt' }, 2),
      ], 2000, 2),
    ]));
    reflowStore.enabled = true;
    reflowStore.consent.mockReturnValue('turn_excerpt');
    reflowStore.list.mockReturnValue([{
      sessionId: 'sess-fake-0001',
      turnId: messageId,
      judgeVersion: null,
      redDimensions: [],
      signals: [],
      failureClass: null,
      sources: ['feedback'],
      occurredAt: 2500,
      feedbackAt: 2500,
    }]);
    db.turns.mockReturnValue([
      { id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
      { id: '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d', turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
    ]);

    const result = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(result.failed).toEqual([]);
    expect(result.seeds[0]?.prompt).toBe('FEATURE_B_TRIGGER_TURN_PROMPT');
    expect(result.seeds[0]?.prompt).not.toContain('FEATURE_A_FIRST_TURN_PROMPT');
    expect(JSON.stringify(result.seeds[0]?.candidates)).toContain('trigger-turn.txt');
    expect(JSON.stringify(result.seeds[0]?.candidates)).not.toContain('first-turn-secret.txt');
  });

  it('三轮会话事后给第一轮补踩：题面是第一轮原话，候选来自第一轮', async () => {
    const messageId = '550e8400-e29b-41d4-a716-446655440000';
    db.replay.mockResolvedValue(replay([
      turn([
        userBlock('FEATURE_A_FIRST_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'first-turn-secret.txt' }, 1),
      ], 1000, 1),
      turn([
        userBlock('FEATURE_B_TRIGGER_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'trigger-turn.txt' }, 2),
      ], 2000, 2),
      turn([
        userBlock('FEATURE_C_LATER_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'later-turn.txt' }, 3),
      ], 3000, 3),
    ]));
    reflowStore.enabled = true;
    reflowStore.consent.mockReturnValue('turn_excerpt');
    reflowStore.list.mockReturnValue([{
      sessionId: 'sess-fake-0001',
      turnId: messageId,
      judgeVersion: null,
      redDimensions: [],
      signals: [],
      failureClass: null,
      sources: ['feedback'],
      occurredAt: 4000,
      feedbackAt: 4000,
      messageId,
    }]);
    db.turns.mockReturnValue([
      { id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
      { id: '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d', turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
      { id: 'ad1e2f3a-4b5c-6d7e-9f8a-7b6c5d4e3f2a', turn_number: 3, start_time: 3000, turn_type: 'user', parent_turn_id: null },
    ]);
    db.messages.mockReturnValue([
      { id: 'user-1', timestamp: 1000 },
      { id: messageId, timestamp: 1100 },
      { id: 'user-2', timestamp: 2000 },
      { id: 'asst-2', timestamp: 2100 },
      { id: 'user-3', timestamp: 3000 },
      { id: 'asst-3', timestamp: 3100 },
    ]);

    const result = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(result.failed).toEqual([]);
    expect(result.seeds[0]?.prompt).toBe('FEATURE_A_FIRST_TURN_PROMPT');
    expect(result.seeds[0]?.prompt).not.toContain('FEATURE_B_TRIGGER_TURN_PROMPT');
    expect(result.seeds[0]?.prompt).not.toContain('FEATURE_C_LATER_TURN_PROMPT');
    expect(JSON.stringify(result.seeds[0]?.candidates)).toContain('first-turn-secret.txt');
    expect(JSON.stringify(result.seeds[0]?.candidates)).not.toContain('trigger-turn.txt');
    expect(JSON.stringify(result.seeds[0]?.candidates)).not.toContain('later-turn.txt');
  });

  it('多候选会话只把最新那条的信号写进 tags，不混入旧评分轮', async () => {
    db.replay.mockResolvedValue(replay([
      turn([userBlock('FEATURE_A_FIRST_TURN_PROMPT')], 1000, 1),
    ]));
    reflowStore.enabled = true;
    reflowStore.consent.mockReturnValue('turn_excerpt');
    reflowStore.list.mockReturnValue([
      {
        sessionId: 'sess-fake-0001',
        turnId: '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d',
        judgeVersion: 'postlaunch-judge-v1',
        redDimensions: ['goal'],
        signals: ['timeout'],
        failureClass: 'timeout',
        sources: ['judge', 'signal'],
        occurredAt: 1000,
      },
      {
        sessionId: 'sess-fake-0001',
        turnId: null,
        judgeVersion: null,
        redDimensions: [],
        signals: [],
        failureClass: null,
        sources: ['feedback'],
        occurredAt: 4000,
        feedbackAt: 4000,
        feedbackId: 'fb-down',
      },
    ]);
    db.turns.mockReturnValue([
      { id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
    ]);

    const result = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(result.failed).toEqual([]);
    expect(result.seeds[0]?.tags).toEqual(expect.arrayContaining(['postlaunch', 'source:feedback']));
    expect(result.seeds[0]?.tags).not.toContain('source:judge');
    expect(result.seeds[0]?.tags).not.toContain('red:goal');
    expect(result.seeds[0]?.tags).not.toContain('signal:timeout');
    expect(result.seeds[0]?.postLaunchReflow).toMatchObject({
      turnId: null,
      feedbackId: 'fb-down',
      sources: ['feedback'],
    });
  });

  it('回流预览保留触发父轮的 iteration 子轮工具/文件，不带后续用户轮', async () => {
    const parentId = '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d';
    db.replay.mockResolvedValue(replay([
      turn([
        userBlock('FEATURE_A_FIRST_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'first-turn-secret.txt' }, 1),
      ], 1000, 1),
      { ...turn([userBlock('FEATURE_B_TRIGGER_TURN_PROMPT')], 2000, 2), turnType: 'user' },
      {
        ...turn([toolBlock('Write', 'Write', { file_path: 'iter-turn.txt' }, 3)], 2100, 3),
        turnType: 'iteration',
        parentTurnId: parentId,
      },
      {
        ...turn([toolBlock('Bash', 'Bash', { command: 'iter-secret-cmd' }, 4)], 2200, 4),
        turnType: 'iteration',
        parentTurnId: parentId,
      },
      turn([
        userBlock('FEATURE_C_LATER_TURN_PROMPT'),
        toolBlock('Write', 'Write', { file_path: 'later-turn.txt' }, 5),
      ], 3000, 5),
    ]));
    reflowStore.enabled = true;
    reflowStore.consent.mockReturnValue('turn_excerpt');
    reflowStore.list.mockReturnValue([{
      sessionId: 'sess-fake-0001',
      turnId: parentId,
      judgeVersion: 'postlaunch-judge-v1',
      redDimensions: ['goal'],
      signals: [],
      failureClass: null,
      sources: ['judge'],
    }]);
    db.turns.mockReturnValue([
      { id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', turn_number: 1, start_time: 1000, turn_type: 'user', parent_turn_id: null },
      { id: parentId, turn_number: 2, start_time: 2000, turn_type: 'user', parent_turn_id: null },
      { id: '8b9c0d1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e', turn_number: 3, start_time: 2100, turn_type: 'iteration', parent_turn_id: parentId },
      { id: '9c0d1e2f-3a4b-5c6d-8e7f-6a5b4c3d2e1f', turn_number: 4, start_time: 2200, turn_type: 'iteration', parent_turn_id: parentId },
      { id: 'ad1e2f3a-4b5c-6d7e-9f8a-7b6c5d4e3f2a', turn_number: 5, start_time: 3000, turn_type: 'user', parent_turn_id: null },
    ]);

    const result = await buildHarvestPreview({
      sessionIds: ['sess-fake-0001'],
      fields: ['prompt'],
      postLaunchReflow: true,
    });
    expect(result.failed).toEqual([]);
    expect(result.seeds[0]?.prompt).toBe('FEATURE_B_TRIGGER_TURN_PROMPT');
    expect(result.seeds[0]?.prompt).not.toContain('FEATURE_A_FIRST_TURN_PROMPT');
    expect(result.seeds[0]?.prompt).not.toContain('FEATURE_C_LATER_TURN_PROMPT');
    const blob = JSON.stringify(result.seeds[0]?.candidates);
    expect(blob).toContain('iter-turn.txt');
    expect(blob).toContain('"tool":"Bash"');
    expect(blob).not.toContain('first-turn-secret.txt');
    expect(blob).not.toContain('later-turn.txt');
  });
});
