// ============================================================================
// T3 留痕：通话本身失败必须让用户看得见，而不只是模型看得见。
//
// host 从 T9(#897) 起就在往会话里落一条 role:'system' + metadata.voiceCallFailure
// 的消息，但投影层的白名单里没有它，于是被「system 一律 skip」那道总闸吞掉：
// 模型读得到（上下文装配走 DB），用户屏幕上一片空白，事后翻历史也找不回。
// 当下唯一的提示是几秒就消失的 toast，通话条又随挂断一起收走。
//
// 这组测试守两件事：
//   1. 这一条确实投影出来了（漏白名单 = 红）；
//   2. **白名单这个机制本身**——任何没被显式放行的 role:'system' 仍然被跳过。
//      只断言第 1 条的话，下次有人把总闸改成「system 全放行」也是绿的，
//      那等于用「全都漏出去」换掉了「漏一项」，门抓不住。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

function callFailure(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-call-failed',
    role: 'system',
    content: '我没能接通这次语音通话',
    timestamp: 3_000,
    metadata: {
      source: 'voice',
      voiceCallFailure: {
        code: 'upstream_closed',
        phase: 'startup',
        timestamp: 3_000,
        neoSessionId: 'session-1',
      },
    },
    ...overrides,
  } as Message;
}

function project(messages: Message[]) {
  return projectTurns(messages, 'session-1', false).turns;
}

function nodesOf(messages: Message[]) {
  return project(messages).flatMap((turn) => turn.nodes);
}

describe('通话失败在聊天流里留得下痕（T3）', () => {
  it('挂在当前轮里，用户事后翻历史找得到', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '帮我打个电话', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '好的', timestamp: 2_000 },
      callFailure(),
    ];

    const turns = project(messages);
    const failureNodes = turns
      .flatMap((turn) => turn.nodes)
      .filter((node) => node.metadata?.voiceCallFailure);

    expect(failureNodes).toHaveLength(1);
    // subtype 决定它渲染成错误样式而不是普通系统灰字——失败要看得出是失败。
    expect(failureNodes[0]?.subtype).toBe('error');
    expect(failureNodes[0]?.content).toBe('我没能接通这次语音通话');
    // 挂在已有轮里，不另起一轮打断阅读。
    expect(turns).toHaveLength(1);
  });

  it('一个轮都没有时独立成轮——失败记录绝不丢，也不留在半空', () => {
    const turns = project([callFailure()]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.nodes.filter((n) => n.metadata?.voiceCallFailure)).toHaveLength(1);
  });

  it('白名单机制本身还在：没被显式放行的 role:system 仍然被跳过', () => {
    // 这条是防「把总闸拆掉换取本用例变绿」的护栏。裸 system 消息（nudge / 恢复提示）
    // 不该上屏；如果它也被投影出来，说明放行方式从「按 metadata 白名单」退化成了
    // 「system 全放行」，本文件第一条用例照样绿，但产品行为已经错了。
    const nodes = nodesOf([
      { id: 'u1', role: 'user', content: '你好', timestamp: 1_000 },
      { id: 'nudge', role: 'system', content: '这是不该上屏的内部提示', timestamp: 2_000 },
    ]);

    expect(nodes.some((node) => node.content === '这是不该上屏的内部提示')).toBe(false);
  });
});
