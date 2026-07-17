// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function question(id: string, sessionId?: string): UserQuestionRequest {
  return {
    id,
    sessionId,
    questions: [
      {
        header: '确认',
        question: '要继续吗',
        options: [
          { label: '继续', description: '继续当前操作' },
          { label: '停止', description: '停下等待' },
        ],
      },
    ],
    timestamp: 1,
  };
}

describe('sessionStore pending user questions', () => {
  beforeEach(() => {
    useSessionStore.setState({
      pendingUserQuestionsBySessionId: new Map<string, UserQuestionRequest[]>(),
    });
  });

  it('stores concurrent questions by session and keeps unrelated sessions isolated', () => {
    const q1 = question('q-1', 'session-a');
    const q2 = question('q-2', 'session-a');
    const qOther = question('q-other', 'session-b');

    useSessionStore.getState().addPendingUserQuestion(q1);
    useSessionStore.getState().addPendingUserQuestion(q2);
    useSessionStore.getState().addPendingUserQuestion(qOther);

    expect(useSessionStore.getState().getPendingUserQuestions('session-a')).toEqual([q1, q2]);
    expect(useSessionStore.getState().getPendingUserQuestions('session-b')).toEqual([qOther]);
  });

  it('clears the answered request without clearing another pending request in the same session', () => {
    const answered = question('q-answered', 'session-a');
    const stillPending = question('q-still-pending', 'session-a');

    useSessionStore.getState().addPendingUserQuestion(answered);
    useSessionStore.getState().addPendingUserQuestion(stillPending);
    useSessionStore.getState().clearPendingUserQuestion(answered);

    expect(useSessionStore.getState().getPendingUserQuestions('session-a')).toEqual([stillPending]);
  });

  it('clears the closed request and removes the empty session bucket', () => {
    const closed = question('q-closed', 'session-a');

    useSessionStore.getState().addPendingUserQuestion(closed);
    useSessionStore.getState().clearPendingUserQuestion(closed);

    expect(useSessionStore.getState().getPendingUserQuestions('session-a')).toEqual([]);
    expect(useSessionStore.getState().pendingUserQuestionsBySessionId.has('session-a')).toBe(false);
  });

  it('does not store legacy user question payloads without sessionId', () => {
    const legacy = question('q-legacy');

    useSessionStore.getState().addPendingUserQuestion(legacy);
    useSessionStore.getState().clearPendingUserQuestion(legacy);

    expect(useSessionStore.getState().pendingUserQuestionsBySessionId.size).toBe(0);
  });
});
