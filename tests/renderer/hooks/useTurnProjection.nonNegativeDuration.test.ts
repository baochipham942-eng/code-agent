import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { encodeGoalNotice } from '../../../src/renderer/components/features/chat/goalNotice';
import { encodeModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

interface NegativeDurationFixture {
  name: string;
  messages: Message[];
  turnId: string;
}

const user = (id: string, timestamp: number): Message => ({
  id,
  role: 'user',
  content: '开始任务',
  timestamp,
});

const voiceDispatch = (timestamp: number): Message => ({
  id: 'voice-dispatch',
  role: 'user',
  content: '创建交付文件',
  timestamp,
  isMeta: true,
  metadata: { voiceDispatch: { title: '创建文件', workItemId: 'voice-work-1' } },
});

const negativeDurationFixtures: NegativeDurationFixture[] = [
  {
    name: 'final close: old assistant',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      { id: 'assistant-old', role: 'assistant', content: '旧时间戳回复', timestamp: 9_000 },
    ],
  },
  {
    name: 'skill_status assignment',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      {
        id: 'skill-old',
        role: 'user',
        source: 'skill',
        content: '<command-message>Loading skill: lark-doc</command-message><command-name>lark-doc</command-name>',
        timestamp: 9_000,
        metadata: { skill: { skillName: 'lark-doc', phase: 'status' } },
      },
    ],
  },
  {
    name: 'goal_notice assignment',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      {
        id: 'goal-old',
        role: 'system',
        source: 'goal',
        content: encodeGoalNotice({ kind: 'met', goal: '开始任务', turns: 1 }),
        timestamp: 9_000,
      },
    ],
  },
  {
    name: 'model_fallback assignment',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      {
        id: 'fallback-old',
        role: 'system',
        source: 'model',
        content: encodeModelFallbackNotice({ reason: 'vision', from: 'model-a', to: 'model-b' }),
        timestamp: 9_000,
      },
    ],
  },
  {
    name: 'context_compression assignment',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      {
        id: 'compression-old',
        role: 'system',
        source: 'system',
        content: JSON.stringify({
          __contextCompressionSignal: {
            signalId: 'compression-old',
            kind: 'success',
            code: 'compaction-succeeded',
            surface: 'conversation',
            timestamp: 9_000,
          },
        }),
        timestamp: 9_000,
      },
    ],
  },
  {
    name: 'automation assignment',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      {
        id: 'automation-old',
        role: 'assistant',
        source: 'automation',
        content: '自动化已创建',
        timestamp: 9_000,
        isMeta: true,
        metadata: {
          automation: {
            automationId: 'cron:job-1',
            automationType: 'cron',
            event: 'created',
            sourceSessionId: 'session-1',
            sourceRefId: 'job-1',
            status: 'active',
            title: '巡检',
          },
        },
      },
    ],
  },
  {
    name: 'artifact matched-turn assignment',
    turnId: 'turn-1',
    messages: [
      voiceDispatch(10_000),
      {
        id: 'voice-subtitle',
        role: 'user',
        content: '继续',
        timestamp: 11_000,
        metadata: { source: 'voice' },
      },
      {
        id: 'artifact-old',
        role: 'system',
        content: '[任务结果] 创建文件｜completed｜已完成',
        timestamp: 9_000,
        metadata: {
          source: 'voice',
          backgroundTaskResult: {
            source: 'agent-result',
            taskId: 'voice-work-1',
            shortName: '创建文件',
            status: 'completed',
            summary: '已完成',
            artifacts: [{
              artifactId: 'artifact-1',
              kind: 'document',
              role: 'deliverable',
              sourceTool: 'Write',
              label: 'delivery.md',
              path: '/repo/delivery.md',
            }],
          },
        },
      },
      {
        id: 'voice-completion',
        role: 'assistant',
        content: '文件已经创建好了。',
        timestamp: 12_000,
        metadata: { source: 'voice' },
      },
    ],
  },
  {
    name: 'system matched-turn assignment',
    turnId: 'turn-1',
    messages: [
      voiceDispatch(10_000),
      user('user-later', 11_000),
      {
        id: 'voice-failure-old',
        role: 'system',
        content: '语音任务失败',
        timestamp: 9_000,
        metadata: {
          source: 'voice',
          voiceWorkFailure: { workItemId: 'voice-work-1', title: '创建文件' },
        },
      },
    ],
  },
  {
    name: 'next-user close assignment',
    turnId: 'turn-1',
    messages: [
      user('user-1', 10_000),
      { id: 'assistant-old', role: 'assistant', content: '旧时间戳回复', timestamp: 9_000 },
      user('user-2', 11_000),
    ],
  },
];

describe('projectTurns non-negative durations', () => {
  it.each(negativeDurationFixtures)('$name', ({ messages, turnId }) => {
    const projection = projectTurns(messages, 'session-1', false);
    const turn = projection.turns.find((candidate) => candidate.turnId === turnId);

    expect(projection.turns.every((candidate) => (
      candidate.endTime === undefined || candidate.endTime >= candidate.startTime
    ))).toBe(true);
    expect(turn?.endTime).toBe(turn?.startTime);
  });

  it('leaves a normal turn duration equal to its last node timestamp minus startTime', () => {
    const projection = projectTurns([
      user('user-1', 10_000),
      { id: 'assistant-1', role: 'assistant', content: '完成', timestamp: 12_500 },
    ], 'session-1', false);
    const turn = projection.turns[0];

    expect(turn.endTime).toBe(12_500);
    expect(turn.endTime! - turn.startTime).toBe(2_500);
  });

  it('leaves streaming turns without an endTime', () => {
    const projection = projectTurns([
      user('user-1', 10_000),
      { id: 'assistant-old', role: 'assistant', content: '进行中', timestamp: 9_000 },
    ], 'session-1', true);
    const turn = projection.turns[0];

    expect(turn.status).toBe('streaming');
    expect(turn.endTime).toBeUndefined();
    expect(turn.nodes.map((node) => node.timestamp)).toEqual([10_000, 9_000]);
  });
});
