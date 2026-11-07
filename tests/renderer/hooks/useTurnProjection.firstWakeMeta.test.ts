import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

describe('projectTurns · first-wake internal prompt', () => {
  it('hides the meta prompt and renders only the expert intro after hydration', () => {
    const internalPrompt = '你刚被用户创建为一位持久化专家。这不是用户发来的消息。';
    const messages: Message[] = [
      {
        id: 'first-wake-user-1',
        role: 'user',
        content: internalPrompt,
        timestamp: 100,
        isMeta: true,
        source: 'system',
      },
      {
        id: 'first-wake-assistant-1',
        role: 'assistant',
        content: '我看到了本周的三个日程冲突，可以先帮你逐一确认。',
        timestamp: 200,
      },
    ];

    const projection = projectTurns(messages, 'first-wake-session', false, []);
    const nodes = projection.turns.flatMap((turn) => turn.nodes);
    expect(nodes.some((node) => node.content.includes(internalPrompt))).toBe(false);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      messageId: 'first-wake-assistant-1',
      type: 'assistant_text',
      content: '我看到了本周的三个日程冲突，可以先帮你逐一确认。',
    });
  });
});
