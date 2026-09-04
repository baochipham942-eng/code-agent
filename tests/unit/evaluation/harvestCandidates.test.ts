import { describe, expect, it } from 'vitest';
import {
  deriveExpectationCandidates,
  deriveHarvestSeed,
  resolveFeedbackTurn,
  toWorkspaceRelativePath,
} from '@internal-evaluation/host/evaluation/harvestCandidates';
import { buildHarvestPreviewWith, harvestBatchTag } from '@internal-evaluation/host/evaluation/harvestPreview';
import type {
  ReplayBlock,
  ReplayToolCategory,
  ReplayTurn,
  StructuredReplay,
} from '../../../src/shared/contract/evaluation';

const WORKDIR = '/tmp/harvest-workspace';

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
    toolCall: {
      id: `call-${name}-${timestamp}`,
      name,
      args,
      success: true,
      duration: 1,
      category,
    },
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

describe('从会话推候选判定标准', () => {
  it('真阳：写文件出 file_exists，调过的工具去重出 tool_called', () => {
    const result = deriveExpectationCandidates({
      replay: replay([turn([
        userBlock('生成一份报告'),
        toolBlock('Write', 'Write', { file_path: `${WORKDIR}/out/summary.html` }, 1),
        toolBlock('Write', 'Write', { file_path: `${WORKDIR}/out/summary.html` }, 2),
      ])]),
      workingDirectory: WORKDIR,
      negativeFeedbackAt: [],
    });

    expect(result.candidates).toEqual([
      { type: 'file_exists', params: { path: 'out/summary.html' }, reason: '会话里写了 out/summary.html' },
      { type: 'tool_called', params: { tool: 'Write' }, reason: '会话里调用了 Write' },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('真阴：零工具调用不出任何候选，给「需手动补一条」的提示', () => {
    const result = deriveExpectationCandidates({
      replay: replay([turn([userBlock('聊两句')])]),
      workingDirectory: WORKDIR,
      negativeFeedbackAt: [],
    });

    expect(result.candidates).toEqual([]);
    expect(result.notes).toContain('noCandidates');
  });

  it('真阴：越出工作区的绝对路径不出候选（只剩 tool_called）', () => {
    const result = deriveExpectationCandidates({
      replay: replay([turn([
        toolBlock('Write', 'Write', { file_path: '/etc/hosts' }),
        toolBlock('Edit', 'Edit', { file_path: `${WORKDIR}/../outside.txt` }),
      ])]),
      workingDirectory: WORKDIR,
      negativeFeedbackAt: [],
    });

    expect(result.candidates.filter((candidate) => candidate.type === 'file_exists')).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.params.tool)).toEqual(['Write', 'Edit']);
  });

  it('点踩那轮含 Bash → command_succeeds 反向候选', () => {
    const result = deriveExpectationCandidates({
      replay: replay([
        turn([userBlock('跑一下检查')], 1000, 1),
        turn([toolBlock('Bash', 'Bash', { command: 'python3 check.py' }, 2001)], 2000, 2),
      ]),
      workingDirectory: WORKDIR,
      negativeFeedbackAt: [2500],
    });

    expect(result.candidates).toContainEqual({
      type: 'command_succeeds',
      params: { command: 'python3 check.py' },
      reason: '点踩那轮的反向候选',
    });
    expect(result.notes).not.toContain('negativeFeedbackNeedsManual');
  });

  it('点踩那轮推不出东西时只给提示，不编造候选', () => {
    const result = deriveExpectationCandidates({
      replay: replay([turn([userBlock('为什么这么慢')], 1000, 1)]),
      workingDirectory: WORKDIR,
      negativeFeedbackAt: [1500],
    });

    expect(result.candidates).toEqual([]);
    expect(result.notes).toEqual(['noCandidates', 'negativeFeedbackNeedsManual']);
  });

  it('相对路径原样保留，绝对路径在工作目录未知时不出候选', () => {
    expect(toWorkspaceRelativePath('out/summary.html', WORKDIR)).toBe('out/summary.html');
    expect(toWorkspaceRelativePath(`${WORKDIR}/a/b.txt`, WORKDIR)).toBe('a/b.txt');
    expect(toWorkspaceRelativePath('/var/log/x.txt', '')).toBeNull();
    expect(toWorkspaceRelativePath('../escape.txt', WORKDIR)).toBeNull();
  });

  it('点踩时刻早于所有轮次时回落第一轮', () => {
    const turns = [turn([], 5000, 1), turn([], 6000, 2)];
    expect(resolveFeedbackTurn(turns, 100)?.turnNumber).toBe(1);
    expect(resolveFeedbackTurn(turns, 6500)?.turnNumber).toBe(2);
    expect(resolveFeedbackTurn([], 1)).toBeNull();
  });
});

describe('草稿预填', () => {
  const source = replay([turn([
    userBlock('在工作目录里读 sales.csv，生成 out/summary.html'),
    toolBlock('Write', 'Write', { file_path: `${WORKDIR}/out/summary.html` }),
  ])], 'risk');

  it('勾上质量标记时带 quality-<grade> 标签；不勾就不带', () => {
    const withQuality = deriveHarvestSeed({
      replay: source,
      sessionTitle: '生成销售报告',
      workingDirectory: WORKDIR,
      fields: ['prompt', 'sourceSessionId', 'qualityTags'],
      batchTag: 'harvest-0904',
      negativeFeedbackAt: [],
    });
    expect(withQuality.tags).toEqual(['harvest-0904', 'quality-risk']);
    expect(withQuality.id).toBe('draft-fake0001');
    expect(withQuality.prompt).toBe('在工作目录里读 sales.csv，生成 out/summary.html');
    expect(withQuality.description).toBe('生成销售报告');

    const withoutQuality = deriveHarvestSeed({
      replay: source,
      sessionTitle: '生成销售报告',
      workingDirectory: WORKDIR,
      fields: ['prompt', 'sourceSessionId'],
      batchTag: 'harvest-0904',
      negativeFeedbackAt: [],
    });
    expect(withoutQuality.tags).toEqual(['harvest-0904']);
  });

  it('工具调用序列默认不进描述，勾上后才作为背景写进描述', () => {
    const seed = deriveHarvestSeed({
      replay: source,
      sessionTitle: '生成销售报告',
      workingDirectory: WORKDIR,
      fields: ['prompt', 'sourceSessionId', 'toolTrace'],
      batchTag: 'harvest-0904',
      negativeFeedbackAt: [],
    });
    expect(seed.description).toContain('Write');
  });
});

describe('预览编排', () => {
  const deps = {
    loadReplay: async (sessionId: string) => (sessionId === 'sess-fake-0001'
      ? replay([turn([userBlock('干点活'), toolBlock('Write', 'Write', { file_path: 'out/a.txt' })])])
      : null),
    loadSession: () => ({ title: '一场会话', workingDirectory: WORKDIR }),
    loadNegativeFeedbackAt: () => [],
    now: () => new Date('2026-09-04T00:00:00Z'),
  };

  it('取不到内容的会话只进 failed，不炸整批', async () => {
    const result = await buildHarvestPreviewWith(
      { sessionIds: ['sess-fake-0001', 'sess-fake-0002'], fields: ['prompt'] },
      deps,
    );
    expect(result.seeds).toHaveLength(1);
    expect(result.failed).toEqual([{ sessionId: 'sess-fake-0002', error: '这场会话没有可回放的记录' }]);
    expect(result.seeds[0].tags[0]).toBe(harvestBatchTag(new Date('2026-09-04T00:00:00Z')));
  });

  it('前端没传锁定行也照样带上来源会话（来源必须留）', async () => {
    const result = await buildHarvestPreviewWith({ sessionIds: ['sess-fake-0001'], fields: [] }, deps);
    expect(result.seeds[0].sessionId).toBe('sess-fake-0001');
  });

  it('一场都没选时直接报错', async () => {
    await expect(buildHarvestPreviewWith({ sessionIds: [], fields: [] }, deps)).rejects.toThrow('请先选择至少一场会话');
  });
});
