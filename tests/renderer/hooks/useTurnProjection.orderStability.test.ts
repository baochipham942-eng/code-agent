// ============================================================================
// 活动轮事后重排 —— 顺序稳定性（2026-08-01 症状 2）
//
// 用户所见：流式过程中块顺序反复跳，完轮瞬间再整体重排一次。
// 排查（docs/plans/2026-08-01-主线三症排查-REPORT.md 症状 2）定位到 projectTurns
// 对活动轮做的两类事后处理：
//   ① relocateActiveTurnReasoningToTail —— 流式期把首个思考块搬到轮尾，完轮弹回轮首；
//   ② markRecoveredFailures —— 重试成功后回溯把失败工具行降级。
//
// 本用例组钉三件事：
//   A. ② 只翻状态、不动顺序（与方向无关的硬保证，任何修法都必须继续成立）；
//   B. ① 收窄为「只搬正在生长的那条响应的思考」（本单修复）——多响应轮里，早期响应
//      那块已经写完的思考不再随本轮新内容一路下滑，事故轮形状下流式序 = 完成序；
//   C. 单响应轮的残留分叉留着：那一处「流式贴底 vs 历史思考先于工具」是 PR #541
//      （2f60b8005, 2026-07-21）**刻意**的取舍并双向钉了测试，不在本单擅自取舍。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

/** 事故轮形状：user → 思考+WebFetch 失败 → 思考+WebFetch 成功 → 正文。 */
function accidentTurnMessages(): Message[] {
  return [
    { id: 'user-1', role: 'user', content: '打开 example.com 看看标题', timestamp: 100 },
    {
      id: 'resp-1',
      role: 'assistant',
      content: '先抓一下页面。',
      reasoning: '用户要标题，先 WebFetch。',
      timestamp: 150,
      toolCalls: [{
        id: 'tc-1',
        name: 'WebFetch',
        arguments: { url: 'https://example.com' },
        result: { toolCallId: 'tc-1', success: false, error: 'fetch failed', duration: 10 },
      }],
      contentParts: [
        { type: 'text', text: '先抓一下页面。' },
        { type: 'tool_call', toolCallId: 'tc-1' },
      ],
    },
    {
      id: 'resp-2',
      role: 'assistant',
      content: '换个方式再试。',
      reasoning: '刚才失败了，重试。',
      timestamp: 200,
      toolCalls: [{
        id: 'tc-2',
        name: 'WebFetch',
        arguments: { url: 'https://example.com' },
        result: { toolCallId: 'tc-2', success: true, output: 'Example Domain', duration: 12 },
      }],
      contentParts: [
        { type: 'text', text: '换个方式再试。' },
        { type: 'tool_call', toolCallId: 'tc-2' },
      ],
    },
    {
      id: 'resp-3',
      role: 'assistant',
      content: 'example.com 的标题是 Example Domain。',
      timestamp: 250,
    },
  ];
}

function nodeOrder(messages: Message[], isProcessing: boolean): string[] {
  const projection = projectTurns(messages, 'session-1', isProcessing, []);
  const turn = projection.turns[projection.turns.length - 1];
  return turn.nodes.map((node) => node.id);
}

describe('markRecoveredFailures 只翻状态、不动顺序', () => {
  it('重试成功让失败行降级为已恢复，但节点排列一个字节没动', () => {
    const messages = accidentTurnMessages();
    const projection = projectTurns(messages, 'session-1', false, []);
    const turn = projection.turns[projection.turns.length - 1];

    // 状态确实翻了（否则这条测试在测空气）
    const failedNode = turn.nodes.find((node) => node.toolCall?.id === 'tc-1');
    expect(failedNode?.toolCall?.success).toBe(false);
    expect(failedNode?.toolCall?.recovered).toBe(true);

    // 顺序与「没有后续成功因而不触发降级」的同形状轮完全一致
    const withoutRecovery = accidentTurnMessages().slice(0, 2);
    const recoveredOrder = turn.nodes
      .map((node) => node.id)
      .slice(0, withoutRecovery.length === 2 ? 3 : 0);
    const baselineOrder = nodeOrder(withoutRecovery, false).slice(0, 3);
    expect(recoveredOrder).toEqual(baselineOrder);
  });
});

/** 带思考内容的节点在轮里的下标（用户眼中「思考块在第几位」）。 */
function reasoningNodeIndexes(messages: Message[], isProcessing: boolean): number[] {
  const projection = projectTurns(messages, 'session-1', isProcessing, []);
  const turn = projection.turns[projection.turns.length - 1];
  return turn.nodes
    .map((node, index) => (node.reasoning || node.thinking ? index : -1))
    .filter((index) => index >= 0);
}

describe('多响应轮：早期响应的思考块不再被搬走（本次修复）', () => {
  it('事故轮形状下，流式序与完成序逐块一致', () => {
    const messages = accidentTurnMessages();

    expect(nodeOrder(messages, true)).toEqual(nodeOrder(messages, false));
    expect(reasoningNodeIndexes(messages, true)).toEqual(reasoningNodeIndexes(messages, false));
    // resp-1 的思考待在自己的文本节点上（第 2 位），不再挂到轮尾 live 节点上
    // 随后续响应不断下滑
    expect(nodeOrder(messages, true)).not.toContain('resp-1-reasoning-live');
    expect(reasoningNodeIndexes(messages, false)[0]).toBe(1);
  });

  it('轮里只有一条响应时，尾置仍然生效（PR #541 的防闪意图原样保留）', () => {
    const single = accidentTurnMessages().slice(0, 2);
    const streamingOrder = nodeOrder(single, true);

    expect(streamingOrder[streamingOrder.length - 1]).toBe('resp-1-reasoning-live');
  });
});

// ---------------------------------------------------------------------------
// 残留分叉（待产品拍板，本单不擅自取舍）
//
// 单响应轮里，正在生长的那条消息的思考在流式期挂轮尾 live 节点、完轮回落到它自己的
// 文本节点（在该响应的工具卡之前）。这一处「流式序 ≠ 完成序」是 PR #541
// （2f60b8005, 2026-07-21）**刻意**的取舍并双向钉了测试：流式要贴底防闪，历史要
// 「思考先于工具」的因果序。两者在当前锚点模型下不可兼得——要么牺牲历史因果序（把
// 思考钉在该响应工具卡之后），要么牺牲流式贴底（改走视觉滚动锚定，需真机验证）。
// 选定方向后，本用例应改写为断言两序相等。
// ---------------------------------------------------------------------------
describe('残留分叉：单响应轮的思考尾置（PR #541 刻意取舍，待拍板）', () => {
  it('仅 isProcessing 翻转，思考块位置仍会变一次', () => {
    const single = accidentTurnMessages().slice(0, 2);

    const streamingReasoningAt = reasoningNodeIndexes(single, true);
    const completedReasoningAt = reasoningNodeIndexes(single, false);
    expect(streamingReasoningAt).not.toEqual(completedReasoningAt);
    // 完成态回落到「思考先于工具」：文本节点在工具卡之前
    expect(completedReasoningAt[0]).toBe(1);
  });
});
