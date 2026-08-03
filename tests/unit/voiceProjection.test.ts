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
import { applyVoicePartialsToProjection, resolvePartialRelease, VOICE_PARTIAL_TURN_ID } from '../../src/renderer/utils/voicePartialOverlay';

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

// ============================================================================
// 批 H：partial 字幕改成流尾的临时气泡（原地流式改写），不再是输入框上方独立一行。
// 钉三件事：只在通话中的那条会话叠加、节点 id 恒定（换 id 会重挂载打塌高度，
// 批 F 的 F3 根因）、不抢正在跑的 run 的吸底驱动。
// ============================================================================
describe('通话 partial 的投影叠加（批 H）', () => {
  const base = () => projectTurns([voiceTranscript('voice-user-1', 'user', '你好', 1000)], 'session-1', false);

  it('没在通话时不叠加任何东西', () => {
    const projection = base();
    const next = applyVoicePartialsToProjection(projection, {
      live: false, user: '正在说的话', assistant: '', startedAt: 1000,
    });
    expect(next).toBe(projection);
  });

  it('通话中把 partial 投成流尾的临时气泡，且带与真消息同款的 voice 来源标记', () => {
    const next = applyVoicePartialsToProjection(base(), {
      live: true, user: '把大纲改成三段', assistant: '好的，我来', startedAt: 1000,
    });
    const tail = next.turns.at(-1)!;
    expect(tail.turnId).toBe(VOICE_PARTIAL_TURN_ID);
    expect(tail.nodes.map((n) => [n.type, n.content])).toEqual([
      ['user', '把大纲改成三段'],
      ['assistant_text', '好的，我来'],
    ]);
    // 交接给真消息时徽标不该闪现/消失
    expect(tail.nodes.every((n) => n.metadata?.source === 'voice')).toBe(true);
  });

  it('文本增长时节点 id 恒定（换 id = 重挂载 = 列表高度塌陷）', () => {
    const first = applyVoicePartialsToProjection(base(), { live: true, user: '把大', assistant: '', startedAt: 1000 });
    const second = applyVoicePartialsToProjection(base(), { live: true, user: '把大纲改成三段', assistant: '', startedAt: 1000 });
    expect(second.turns.at(-1)!.nodes[0].id).toBe(first.turns.at(-1)!.nodes[0].id);
    expect(second.turns.at(-1)!.turnId).toBe(first.turns.at(-1)!.turnId);
    expect(second.turns.at(-1)!.startTime).toBe(first.turns.at(-1)!.startTime);
  });

  it('空 partial 不产生空气泡', () => {
    const projection = base();
    expect(applyVoicePartialsToProjection(projection, { live: true, user: '   ', assistant: '', startedAt: 1000 }))
      .toBe(projection);
  });

  it('已有轮在流式时不抢吸底驱动，没有才接管', () => {
    const streaming = { ...base(), activeTurnIndex: 0 };
    expect(applyVoicePartialsToProjection(streaming, { live: true, user: '喂', assistant: '', startedAt: 1000 }).activeTurnIndex)
      .toBe(0);

    const idle = { ...base(), activeTurnIndex: -1 };
    const next = applyVoicePartialsToProjection(idle, { live: true, user: '喂', assistant: '', startedAt: 1000 });
    expect(next.activeTurnIndex).toBe(next.turns.length - 1);
  });
});

// 交接缝：final 到了不能立刻清 partial（落库异步 + 还要等 500ms 拉消息），
// 否则临时气泡先消失、真气泡后出现＝一次肉眼可见的闪断。
describe('partial 与真消息的交接（批 H）', () => {
  it('顶着的那句在真消息上屏后才撤', () => {
    expect(resolvePartialRelease({ user: '把大纲改成三段' }, { user: '把大纲改成三段', assistant: '' }, { user: true, assistant: false }))
      .toEqual({ partialUser: '' });
  });

  it('空档里又开口了就不撤（别把正在说的下一句抹掉）', () => {
    expect(resolvePartialRelease({ user: '把大纲改成三段' }, { user: '再帮我', assistant: '' }, { user: true, assistant: false }))
      .toEqual({});
  });

  it('只撤已 final 的那一侧，另一侧照常在说', () => {
    expect(resolvePartialRelease({ assistant: '好的' }, { user: '你还在吗', assistant: '好的' }, { user: false, assistant: true }))
      .toEqual({ partialAssistant: '' });

  });

  it('真消息还没上屏就不撤——撤了就是一段谁都没有这句话的空帧（R1 闪断）', () => {
    expect(resolvePartialRelease({ assistant: '好的' }, { user: '', assistant: '好的' }, { user: false, assistant: false }))
      .toEqual({});
  });

  it('合并行落地时只剥掉已定稿前缀，保留尚未落库的当前段', () => {
    expect(resolvePartialRelease(
      { user: 'aaaa' },
      { user: 'aaaa bbbb', assistant: '' },
      { user: true, assistant: false },
    )).toEqual({ partialUser: 'bbbb' });
  });

  it('已定稿前缀不是当前气泡的完整开头时不误剥', () => {
    expect(resolvePartialRelease(
      { user: 'aaaa' },
      { user: 'xaaaa bbbb', assistant: '' },
      { user: true, assistant: false },
    )).toEqual({});
  });
});

// 语音派出的那条指令不是用户说的话——它是通话 brain 改写后发给执行引擎的。
// 存的是 role:'user'（runtime 需要用户轮），但顶着用户身份显示在右边 = 把话安在用户嘴里。
// 判据是投影出来的节点类型，不是「metadata 存下来了」。
describe('语音派出的指令不冒充用户消息（批 H）', () => {
  const dispatch = (id: string, timestamp: number): Message => ({
    id,
    role: 'user',
    content: '用户要求在工作目录下创建一个名为 test3.txt 的文件。请执行此操作。',
    timestamp,
    metadata: { voiceDispatch: { title: '建 test3.txt' } },
  });

  it('投成左侧节点而不是用户气泡', () => {
    const projection = projectTurns([dispatch('voice-dispatch-1', 1000)], 'session-1', false);
    const node = projection.turns.flatMap((t) => t.nodes).find((n) => n.id === 'voice-dispatch-1');
    expect(node?.type).toBe('assistant_text');
    expect(node?.metadata?.voiceDispatch?.title).toBe('建 test3.txt');
  });

  it('用户真说的那句仍然是用户气泡（别把语音消息一锅端）', () => {
    const projection = projectTurns([
      voiceTranscript('voice-user-1', 'user', '在工作目录建个文件，叫 test 三点 txt', 900),
      dispatch('voice-dispatch-1', 1000),
    ], 'session-1', false);
    const nodes = projection.turns.flatMap((t) => t.nodes);
    expect(nodes.find((n) => n.id === 'voice-user-1')?.type).toBe('user');
    expect(nodes.find((n) => n.id === 'voice-dispatch-1')?.type).toBe('assistant_text');
  });
});
