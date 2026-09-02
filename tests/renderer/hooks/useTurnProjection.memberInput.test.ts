// N-SUBAGENT-INPUT：用户给成员补话的 isMeta 记录要投影成一行（和自动化提示同一条路），
// 其它 isMeta 仍然不露出。
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

describe('projectTurns · member input record', () => {
  it('projects isMeta+memberInput as one node carrying the metadata, hides plain meta', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '帮我做个报告', timestamp: 100 },
      {
        id: 'steer-1', role: 'user', content: '顺便把页码加上', timestamp: 110, isMeta: true,
        metadata: { memberInput: { memberId: 'task-7', memberName: '报告任务', mode: 'supplement' } },
      },
      { id: 'hidden-1', role: 'user', content: 'hidden internal note', timestamp: 111, isMeta: true },
    ];
    const projection = projectTurns(messages, 'session-1', false, []);
    const nodes = projection.turns.flatMap((turn) => turn.nodes);
    const record = nodes.find((node) => node.messageId === 'steer-1');
    expect(record).toMatchObject({ id: 'steer-1-member-input', type: 'assistant_text', content: '顺便把页码加上' });
    expect(record?.metadata?.memberInput).toEqual({ memberId: 'task-7', memberName: '报告任务', mode: 'supplement' });
    expect(nodes.some((node) => node.messageId === 'hidden-1')).toBe(false);
  });

  // 专家团路径落的是可见 user 消息（团长推理要看得到，不能 isMeta）：展示上同样折叠成一行，不开新轮
  it('folds a visible user message carrying memberInput into the current turn instead of starting a new turn', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '帮我做个报告', timestamp: 100 },
      { id: 'assistant-1', role: 'assistant', content: '好，开始', timestamp: 105 },
      {
        id: 'direct-1', role: 'user', content: '换成按季度汇总', timestamp: 110,
        metadata: { memberInput: { memberId: 'scoped:researcher', memberName: '行业研究员', mode: 'redirect' } },
      },
    ];
    const projection = projectTurns(messages, 'session-1', false, []);
    expect(projection.turns).toHaveLength(1);
    const record = projection.turns[0].nodes.find((node) => node.messageId === 'direct-1');
    expect(record).toMatchObject({ id: 'direct-1-member-input', type: 'assistant_text', content: '换成按季度汇总' });
    expect(record?.metadata?.memberInput?.mode).toBe('redirect');
  });
});
