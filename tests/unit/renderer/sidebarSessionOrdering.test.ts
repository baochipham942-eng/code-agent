import { describe, expect, it } from 'vitest';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { SessionStatusKind } from '../../../src/renderer/utils/sessionPresentation';
import {
  getSidebarSessionRecoveryPriority,
  sortSidebarSessionsForRecovery,
} from '../../../src/renderer/utils/sidebarSessionOrdering';

function makeSession(id: string, updatedAt: number): SessionWithMeta {
  return {
    id,
    title: id,
    createdAt: updatedAt - 1,
    updatedAt,
    modelConfig: { provider: 'test' as any, model: 'test' },
    messageCount: 1,
    turnCount: 1,
  } as SessionWithMeta;
}

describe('sidebarSessionOrdering', () => {
  it('prioritizes approval, running, and attention sessions before completed sessions', () => {
    const sessions = [
      makeSession('done-new', 500),
      makeSession('attention-new', 400),
      makeSession('live', 300),
      makeSession('background', 250),
      makeSession('approval-old', 100),
      makeSession('done-old', 50),
    ];
    const kinds: Record<string, SessionStatusKind> = {
      'done-new': 'done',
      'attention-new': 'error',
      live: 'live',
      background: 'background',
      'approval-old': 'approval',
      'done-old': 'idle',
    };

    const sorted = sortSidebarSessionsForRecovery(sessions, (session) => kinds[session.id]);

    expect(sorted.map((session) => session.id)).toEqual([
      'approval-old',
      'live',
      'background',
      'attention-new',
      'done-new',
      'done-old',
    ]);
  });

  it('keeps recency order inside the same recovery bucket', () => {
    const sessions = [
      makeSession('older-running', 100),
      makeSession('newer-running', 200),
      makeSession('newest-running', 300),
    ];

    const sorted = sortSidebarSessionsForRecovery(sessions, () => 'live');

    expect(sorted.map((session) => session.id)).toEqual([
      'newest-running',
      'newer-running',
      'older-running',
    ]);
  });

  it('does not mutate the input sessions array', () => {
    const sessions = [
      makeSession('done', 200),
      makeSession('approval', 100),
    ];

    const sorted = sortSidebarSessionsForRecovery(
      sessions,
      (session) => session.id === 'approval' ? 'approval' : 'done',
    );

    expect(sorted.map((session) => session.id)).toEqual(['approval', 'done']);
    expect(sessions.map((session) => session.id)).toEqual(['done', 'approval']);
  });

  it('exposes stable numeric priorities for sidebar badges', () => {
    expect(getSidebarSessionRecoveryPriority('approval')).toBeLessThan(
      getSidebarSessionRecoveryPriority('live'),
    );
    expect(getSidebarSessionRecoveryPriority('live')).toBeLessThan(
      getSidebarSessionRecoveryPriority('paused'),
    );
    expect(getSidebarSessionRecoveryPriority('paused')).toBeLessThan(
      getSidebarSessionRecoveryPriority('done'),
    );
  });
});
