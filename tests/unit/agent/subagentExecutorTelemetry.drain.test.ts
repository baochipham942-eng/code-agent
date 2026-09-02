// N-SUBAGENT-INPUT：成员收件箱里 from='user' 的文本注入时按用户来源打前缀，不冒充父 agent。
import { describe, expect, it, vi } from 'vitest';
import { drainSubagentMessages } from '../../../src/host/agent/subagentExecutorTelemetry';
import type { RuntimeMessage } from '../../../src/host/agent/subagentExecutorProjection';

describe('drainSubagentMessages', () => {
  it('prefixes user-origin text as a user message and parent text as a parent agent message', () => {
    const messages: RuntimeMessage[] = [];
    const injected = drainSubagentMessages({
      agentName: 'researcher',
      messages,
      pendingMessages: [
        { type: 'text', from: 'user', payload: '顺便把页码加上', timestamp: 1 },
        { type: 'text', from: 'parent', payload: '先看第三章', timestamp: 2 },
      ],
      logger: { info: vi.fn() },
      pushObservabilityMessage: vi.fn(),
    });
    expect(injected).toBe(2);
    expect(messages.map((message) => message.content)).toEqual([
      '[User message]: 顺便把页码加上',
      '[Parent agent message]: 先看第三章',
    ]);
  });
});
