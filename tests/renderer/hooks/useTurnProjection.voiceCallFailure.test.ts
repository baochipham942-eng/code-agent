// ============================================================================
// T3 留痕：通话本身失败必须让用户看得见，而不只是模型看得见。
//
// host 从 T9(#897) 起就在往会话里落一条 role:'system' + metadata.voiceCallFailure
// 的消息，但投影层的白名单里没有它，于是被「system 一律 skip」那道总闸吞掉：
// 模型读得到（上下文装配走 DB），用户屏幕上一片空白，事后翻历史也找不回。
// 当下唯一的提示是几秒就消失的 toast，通话条又随挂断一起收走。
//
// 这组测试守的是「这一条确实投影出来了」（摘掉白名单分支 = 红，已变异验证）。
//
// **写不出来的那条，如实记在这里**：本来还想守「白名单机制本身」——即有人把
// `if (msg.role === 'system') continue;` 那道总闸拆掉时要报红。实测该变异**不会红**，
// 因为它拆了也没用：总闸之后的每个分支都门在 role==='user' / 'assistant' 上，
// 掉下去的 system 消息本来就产不出任何节点。那道 continue 是纯防御性的短路。
// 所以这个盲区不是「测试没写好」，是它没有可观测的失败面——真正的风险变异是
// **新增一个放行 system 的分支**，那属于新增代码，只能靠 review 拦，不能靠这里。
// 留一条永远不会红的断言在这儿会冒充覆盖，故不留。
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
});
