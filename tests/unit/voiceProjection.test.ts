// ============================================================================
// 语音消息投影合流门（§7.5，防重影）——真实 model 层，零 mock。
//
// #706/#713 教训：组件单测把 model 层 mock 掉之后，同一份产物投影两遍也看不见。
// 这里直接把「host 落库长什么样」的消息喂给真 projectTurns，断言：
//   - voice_call_summary 恰好投影一次（host 是单一生产者，renderer 无第二条路径）；
//   - 字幕 final 走正常 user/assistant 气泡，不因 metadata.source='voice' 被吞或翻倍；
//   - 普通 system 消息维持既有「不投影」行为不被这条分支误伤。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { projectTurns } from '../../src/renderer/hooks/useTurnProjection';
import type { Message } from '../../src/shared/contract/message';
import { QWEN_OMNI_REALTIME_MODEL } from '../../src/shared/constants/voice';

function voiceTranscript(id: string, role: 'user' | 'assistant', content: string, timestamp: number): Message {
  // 与 voiceSessionService.persistTranscript 落库形状逐字段对齐
  return { id, role, content, timestamp, metadata: { source: 'voice' } };
}

function voiceSummary(id: string, timestamp: number): Message {
  // 与 voiceSessionService.teardown 落库形状逐字段对齐
  return {
    id,
    role: 'system',
    content: '语音通话结束，时长 1 分 15 秒',
    timestamp,
    metadata: {
      source: 'voice',
      voiceCallSummary: {
        durationSec: 75,
        provider: 'qwen-omni',
        conversationModel: QWEN_OMNI_REALTIME_MODEL,
        workItemCount: 2,
        startedAt: timestamp - 75_000,
        endedAt: timestamp,
      },
    },
  };
}

describe('语音消息投影（真实 projectTurns，无 mock）', () => {
  it('一通通话 = 两条字幕气泡 + 恰好一张摘要卡，不重影', () => {
    const messages: Message[] = [
      voiceTranscript('voice-user-1', 'user', '帮我看下登录页', 1000),
      voiceTranscript('voice-assistant-1', 'assistant', '好的，我看一下。', 2000),
      voiceSummary('voice-summary-1', 3000),
    ];

    const projection = projectTurns(messages, 'session-1', false);
    const allNodes = projection.turns.flatMap((turn) => turn.nodes);

    const summaryNodes = allNodes.filter((node) => node.subtype === 'voice_call_summary');
    expect(summaryNodes).toHaveLength(1);
    expect(summaryNodes[0].metadata?.voiceCallSummary?.durationSec).toBe(75);

    const userNodes = allNodes.filter((node) => node.type === 'user');
    expect(userNodes).toHaveLength(1);
    expect(userNodes[0].metadata?.source).toBe('voice');

    const assistantNodes = allNodes.filter(
      (node) => node.type === 'assistant_text' && node.content === '好的，我看一下。',
    );
    expect(assistantNodes).toHaveLength(1);

    // 重影定义：同一 message id 出现多于一次
    const ids = allNodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('摘要消息在没有任何前置 turn 时独立成 turn（通话先于任何文字输入）', () => {
    const projection = projectTurns([voiceSummary('voice-summary-1', 3000)], 'session-1', false);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].nodes).toHaveLength(1);
    expect(projection.turns[0].nodes[0].subtype).toBe('voice_call_summary');
  });

  it('摘要挂在进行中的 turn 尾部（通话延续文字上下文），且普通 system 消息仍被跳过', () => {
    const typedUser: Message = { id: 'typed-1', role: 'user', content: '先聊两句', timestamp: 500 };
    const plainSystem: Message = { id: 'sys-1', role: 'system', content: 'recovery hint', timestamp: 2500 };
    const messages: Message[] = [
      typedUser,
      voiceTranscript('voice-user-1', 'user', '接着说', 1000),
      plainSystem,
      voiceSummary('voice-summary-1', 3000),
    ];

    const projection = projectTurns(messages, 'session-1', false);
    const allNodes = projection.turns.flatMap((turn) => turn.nodes);

    expect(allNodes.some((node) => node.id === 'sys-1')).toBe(false);
    expect(allNodes.filter((node) => node.subtype === 'voice_call_summary')).toHaveLength(1);

    // 语音 user 消息开了新 turn，摘要落在那个 turn 里
    const voiceTurn = projection.turns.find((turn) => turn.nodes.some((node) => node.id === 'voice-user-1'));
    expect(voiceTurn?.nodes.some((node) => node.subtype === 'voice_call_summary')).toBe(true);
  });

  it('同一批消息重复投影幂等（React 重渲染/流式刷新场景）', () => {
    const messages: Message[] = [
      voiceTranscript('voice-user-1', 'user', '你好', 1000),
      voiceSummary('voice-summary-1', 3000),
    ];
    const first = projectTurns(messages, 'session-1', false);
    const second = projectTurns(messages, 'session-1', false);
    expect(second.turns.flatMap((t) => t.nodes).filter((n) => n.subtype === 'voice_call_summary')).toHaveLength(1);
    expect(JSON.stringify(second.turns)).toBe(JSON.stringify(first.turns));
  });
});
