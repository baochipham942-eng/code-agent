// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message, StreamRecoverySnapshot } from '../../../src/shared/contract';

import {
  deriveRetryTurnMessage,
  deriveStreamInterruptionDecision,
} from '../../../src/renderer/components/ChatView';

function makeSnapshot(overrides: Partial<StreamRecoverySnapshot> = {}): StreamRecoverySnapshot {
  return {
    sessionId: 'session-1',
    turnId: 'turn-abc',
    content: '部分回复内容',
    reasoning: '',
    toolCalls: [],
    estimatedTokens: 10,
    timestamp: Date.now(),
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
    ...overrides,
  };
}

function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-user-1',
    role: 'user',
    content: '帮我写个函数',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAssistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: '好的，我来写',
    timestamp: Date.now(),
    ...overrides,
  };
}

// D-1：streamSnapshot 没有任何字段指回触发它的用户消息（turnId 是每轮现铸的 UUID，
// 与消息 id 无关联）。锚点靠结构性推导——只要 snapshot 还在，addMessage 必然还没被
// 调用过（它无条件清空 snapshot）。正常 recovery 消息和 host 为取消落下的终止 partial
// 都要跳过，剩下的末位才是触发这轮的用户消息。deriveRetryTurnMessage 是这条推导本身，
// 不许再让它裸奔在 ChatView 函数体里靠喂 Banner props 间接测。
describe('deriveRetryTurnMessage — 锚点推导', () => {
  it('末位是 user 消息：返回该消息', () => {
    const userMsg = makeUserMessage();
    expect(deriveRetryTurnMessage(makeSnapshot(), [makeAssistantMessage({ id: 'old' }), userMsg])).toBe(userMsg);
  });

  it('末位不是 user 消息（是 assistant）：返回 null，不许瞎重发助手消息', () => {
    const messages = [makeUserMessage(), makeAssistantMessage()];
    expect(deriveRetryTurnMessage(makeSnapshot(), messages)).toBeNull();
  });

  it.each([
    '[cancelled]',
    '[未完成 — 切换会话中断]',
  ])('跳过 host 落库终止标记 %s，仍返回触发轮的 user 消息', (marker) => {
    const user = makeUserMessage();
    const interruptedPartial = makeAssistantMessage({
      content: `部分回复\n\n${marker}`,
    });
    expect(deriveRetryTurnMessage(makeSnapshot(), [user, interruptedPartial])).toBe(user);
  });

  it('messages 为空：返回 null', () => {
    expect(deriveRetryTurnMessage(makeSnapshot(), [])).toBeNull();
  });

  it('streamSnapshot 为 null：返回 null（即便 messages 末位是 user）', () => {
    expect(deriveRetryTurnMessage(null, [makeUserMessage()])).toBeNull();
  });
});

describe('deriveStreamInterruptionDecision — 活流式不得误报中断', () => {
  it('真流式 run（incomplete snapshot + 正在出正文 + 活轮）不生成中断决策', () => {
    const user = makeUserMessage({
      id: 'user-live',
      content: '国庆去旧金山和洛杉矶如何',
    });
    const liveSnapshot = makeSnapshot({
      turnId: 'turn-live-stream',
      content: '旧金山秋季适合步行，洛杉矶',
      isFinal: false,
      streamStatus: 'incomplete',
    });
    const streamingRecovery: Message = {
      id: 'turn-live-stream',
      role: 'assistant',
      content: liveSnapshot.content,
      timestamp: Date.now(),
      metadata: { streamRecovery: { turnId: 'turn-live-stream' } },
    };

    expect(deriveStreamInterruptionDecision(
      liveSnapshot,
      [user, streamingRecovery],
      true,
    )).toBeNull();
  });

  it('同一份 incomplete snapshot 在活轮结束后才成为中断决策', () => {
    const user = makeUserMessage({
      id: 'user-live',
      content: '国庆去旧金山和洛杉矶如何',
    });
    const interruptedSnapshot = makeSnapshot({
      turnId: 'turn-live-stream',
      content: '旧金山秋季适合步行，洛杉矶',
      isFinal: false,
      streamStatus: 'incomplete',
      interruptionReason: 'user',
    });

    const decision = deriveStreamInterruptionDecision(
      interruptedSnapshot,
      [user],
      false,
    );
    expect(decision?.retryMessage).toBe(user);
    expect(decision?.snapshot.interruptionReason).toBe('user');
  });
});

describe('ChatView — 中断入口收进 DecisionSlot', () => {
  it('不再挂顶部 StreamRecoveryBanner，唯一动作入口交给 DecisionSlot', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
      'utf8',
    );
    expect(source).not.toContain('<StreamRecoveryBanner');
    expect(source).not.toContain('export const StreamRecoveryBanner');
    expect(source).not.toContain('data-testid="stream-recovery-banner"');
    expect(source).toContain('<DecisionSlot');
    expect(source).toContain('streamInterruption={streamInterruptionDecision}');
    expect(source).toContain('deriveStreamInterruptionDecision');
    expect(source).toContain('effectiveIsProcessing');
  });
});
