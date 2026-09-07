import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

function checkoutNote(id: string, timestamp: number): Message {
  return {
    id,
    role: 'system',
    content: `Turn Redo success ${id}`,
    timestamp,
    metadata: {
      turnCheckoutNote: {
        operation: 'redo',
        state: 'success',
        done: ['conversation', 'note'],
        failed: [],
        skippedFiles: [],
        changedFileCount: 1,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      },
    },
  };
}

describe('turn checkout note 展示层替换', () => {
  it('时间线只留最新一张反悔结果卡，旧卡仍在账本消息里', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '先问', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '先答', timestamp: 2 },
      checkoutNote('note-old', 3),
      checkoutNote('note-new', 4),
    ];
    const nodes = projectTurns(messages, 'session-1', false).turns.flatMap((turn) => turn.nodes);
    expect(nodes.some((node) => node.id === 'note-new' && node.metadata?.turnCheckoutNote)).toBe(true);
    expect(nodes.some((node) => node.id === 'note-old')).toBe(false);
  });
});
