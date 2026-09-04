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
}));

// 宿主取数走真实入口 buildHarvestPreview，只把数据库与回放服务换成夹具
// （与 tests/unit/ipc/evaluationRunBridge.ipc.test.ts 同一套 mock 写法）。
vi.mock('@host/telemetry/replay/telemetryQueryService', () => ({
  getTelemetryQueryService: () => ({ getStructuredReplay: db.replay }),
}));

vi.mock('@host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: db.session,
    getDb: () => ({ prepare: () => ({ all: db.feedback }) }),
  }),
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
    db.session.mockReturnValue({ title: '一场会话', workingDirectory: WORKDIR });
    db.replay.mockImplementation(async (sessionId: string) => (sessionId === 'sess-fake-0001'
      ? replay([turn([userBlock('干点活'), toolBlock('Write', 'Write', { file_path: 'out/a.txt' })])])
      : null));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
});
