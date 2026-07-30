// ============================================================================
// X5.5-D2：语音字幕不是 turn 边界——
// - 通话中用户再开口落的 user 字幕不把装着在跑 run 的派活轮切成 completed；
// - 字幕轮不抢 active 标记（active 仍指在跑的 run 轮，任务卡继续转）；
// - 字幕照常开轮、照常渲染进消息流（豁免的是「关闭上一轮」，不是「不显示」）；
// - 普通 typed 用户消息仍是 turn 边界（关闭上一轮的行为不变）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

/** 派活轮在跑：voiceDispatch 用户消息 + 一条还没写完的 assistant 回复 */
function runningVoiceDispatchMessages(): Message[] {
  return [
    {
      id: 'voice-dispatch-1',
      role: 'user',
      content: '改写后的派活指令全文',
      timestamp: 1_000,
      metadata: { voiceDispatch: { title: '建 test3.txt', workItemId: 'voice-work-1' } },
    },
    { id: 'a1', role: 'assistant', content: '正在建…', timestamp: 2_000 },
  ];
}

describe('projectTurns 语音字幕豁免（X5.5-D2）', () => {
  it('通话中再开口的字幕不把在跑的派活轮切成 completed，active 仍指 run 轮', () => {
    const projection = projectTurns(
      [
        ...runningVoiceDispatchMessages(),
        // 通话中用户再开口落的一条 user 字幕
        { id: 'sub-1', role: 'user', content: '顺便再看下日志', timestamp: 3_000, metadata: { source: 'voice' } },
      ],
      'session-1',
      true,
    );

    expect(projection.turns).toHaveLength(2);
    const [runTurn, subtitleTurn] = projection.turns;
    // 派活轮仍是 active streaming——修前它被字幕当场切成 completed，
    // 任务卡还在转、轮已判完结、尾部动作条挂出。
    expect(runTurn.status).toBe('streaming');
    expect(projection.activeTurnIndex).toBe(0);
    expect(subtitleTurn.status).not.toBe('streaming');
    // 字幕照常开轮、照常进消息流
    expect(
      subtitleTurn.nodes.some((node) => node.type === 'user' && node.content === '顺便再看下日志'),
    ).toBe(true);
  });

  it('普通 typed 用户消息仍关闭上一轮（非语音场景的 turn 边界不变）', () => {
    const projection = projectTurns(
      [
        { id: 'u1', role: 'user', content: '第一问', timestamp: 1_000 },
        { id: 'a1', role: 'assistant', content: '第一答', timestamp: 2_000 },
        { id: 'u2', role: 'user', content: '第二问', timestamp: 3_000 },
      ],
      'session-1',
      true,
    );

    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0].status).toBe('completed');
    // typed 新轮照常拿走 active 标记
    expect(projection.turns[1].status).toBe('streaming');
    expect(projection.activeTurnIndex).toBe(1);
  });
});
