// ============================================================================
// X5.5-D5：通话摘要卡钉到 episode 末尾——
// 语音派出的 run 刻意活得比通话久，挂断后 run 的收尾文本 timestamp 晚于摘要卡的
// endedAt。展示层把 voice_call_summary 节点钉到所在轮末尾（不改落库时序）：
// - 晚到的 run 收尾文本排在摘要卡之前；
// - 钉尾的摘要卡不是活动内容，不把在跑的派活轮从 active 上顶下来。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { VoiceCallSummary } from '../../../src/shared/contract/voice';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const summary: VoiceCallSummary = {
  durationSec: 48,
  provider: 'qwen-omni',
  conversationModel: 'qwen3-omni-flash-realtime',
  workItemCount: 1,
  startedAt: 500,
  endedAt: 2_900,
};

function dispatchThreadWithSummary(): Message[] {
  return [
    {
      id: 'voice-dispatch-1',
      role: 'user',
      content: '改写后的派活指令全文',
      timestamp: 1_000,
      metadata: { voiceDispatch: { title: '建 test3.txt', workItemId: 'voice-work-1' } },
    },
    { id: 'a1', role: 'assistant', content: '正在建…', timestamp: 2_000 },
    // 挂断时落库的摘要（timestamp=endedAt 附近）
    {
      id: 'm-summary',
      role: 'system',
      content: '语音通话结束',
      timestamp: 3_000,
      metadata: { source: 'voice', voiceCallSummary: summary },
    },
  ];
}

describe('projectTurns 通话摘要卡钉尾（X5.5-D5）', () => {
  it('挂断后晚到的 run 收尾文本排在摘要卡之前：摘要卡恒在轮尾', () => {
    const projection = projectTurns(
      [
        ...dispatchThreadWithSummary(),
        // run 活得比通话久：收尾文本 timestamp 晚于摘要卡
        { id: 'a2', role: 'assistant', content: '已创建 test3.txt。', timestamp: 4_000 },
      ],
      'session-1',
      false,
    );

    expect(projection.turns).toHaveLength(1);
    const nodes = projection.turns[0].nodes;
    expect(nodes[nodes.length - 1].subtype).toBe('voice_call_summary');
    // 收尾文本在摘要卡之前（展示层顺序，不落库）
    const textIndex = nodes.findIndex((node) => node.content === '已创建 test3.txt。');
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeLessThan(nodes.length - 1);
  });

  it('钉尾的摘要卡不是活动内容：run 还在跑时派活轮仍是 active streaming', () => {
    const projection = projectTurns(dispatchThreadWithSummary(), 'session-1', true);

    expect(projection.turns).toHaveLength(1);
    const turn = projection.turns[0];
    // 坐实前提：摘要卡钉在轮尾
    expect(turn.nodes[turn.nodes.length - 1].subtype).toBe('voice_call_summary');
    // 轮尾是摘要卡不等于轮闲了——跳过它看到的真实尾节点（assistant_text）才算数
    expect(turn.status).toBe('streaming');
    expect(projection.activeTurnIndex).toBe(0);
  });

  it('没有语音摘要的轮不受钉尾影响', () => {
    const projection = projectTurns(
      [
        { id: 'u1', role: 'user', content: '你好', timestamp: 1_000 },
        { id: 'a1', role: 'assistant', content: '你好', timestamp: 2_000 },
      ],
      'session-1',
      false,
    );
    expect(projection.turns[0].nodes.map((node) => node.type)).toEqual(['user', 'assistant_text']);
  });
});
