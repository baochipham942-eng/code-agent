// N-SUBAGENT-INPUT：isMeta+memberInput 的记录要进 messages（可渲染 meta），裸 isMeta 仍被挡。
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

describe('sessionStore.addMessage · member input meta record', () => {
  beforeEach(() => {
    useSessionStore.setState({ messages: [] });
  });

  it('keeps the member-input record and drops plain meta', () => {
    const store = useSessionStore.getState();
    store.addMessage({
      id: 'steer-1', role: 'user', content: '顺便把页码加上', timestamp: 1, isMeta: true,
      metadata: { memberInput: { memberId: 'task-7', memberName: '报告任务', mode: 'supplement' } },
    });
    store.addMessage({ id: 'hidden-1', role: 'user', content: 'hidden', timestamp: 2, isMeta: true });
    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual(['steer-1']);
  });
});
