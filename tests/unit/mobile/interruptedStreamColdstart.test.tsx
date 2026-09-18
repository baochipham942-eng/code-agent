// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionHistory } from '../../../src/shared/contract/companionLibrary';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

/**
 * R4 模拟器验收 D2：假模型慢流运行中插话（steer）/点停止 → App 杀掉重开 → 被打断的那段流在会话末尾
 * 重复出现（实时 6 行、冷启动 8 行，DB 只有 6 条）。宿主把半段落库（preserveStreamedPartial，尾巴上的
 * [已被新消息打断]/[cancelled] 标记出手机边界前剥掉）但**不发终结 message 事件**，冷启动重放时
 * delta 堆出的流式行没人收编，就追在会话末尾成了重复段。落库半段是新 id，与流的 turnId 对不上，
 * 去重只能按内容 + 时间对齐。
 */
const text = messages('zh');
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>, createdAt: number) => ({ eventId: `e${++seq}`, epoch: 1, seq, sessionId: 's1', kind, payload, createdAt }) as unknown as CompanionEvent;
const msg = (id: string, role: string, content: string, timestamp: number) => ({ id, role, content, timestamp });
const delta = (turnId: string, chunk: string, runId: string, at: number) =>
  ev('message_delta', { role: 'assistant', path: 'content', op: 'append', text: chunk, turnId, runId }, at);

const partial3 = 'R2-SLOW-s3 慢流第1段。R2-SLOW-s3 慢流第2段。';
const partial4 = 'R2-SLOW-s4 慢流第1段。R2-SLOW-s4 慢流第2段。';
const reply = 'R2_OK 已收到：R2-QUEUE-q1 赶上收尾的这句';

// 宿主落库形状（messages 表，中断标记已被投影剥掉）：steer 半段 p3 夹在插话前后，停止半段 p4 在末尾。
const coldHistory = (): CompanionHistory => ({
  sessionId: 's1', nextOffset: null, messages: [
    msg('u1', 'user', '帮我慢慢写', 100),
    msg('p3', 'assistant', partial3, 130),
    msg('u2', 'user', 'R2-QUEUE-q1 赶上收尾的这句', 140),
    msg('a2', 'assistant', reply, 210),
    msg('u3', 'user', '再跑一个慢流', 300),
    msg('p4', 'assistant', partial4, 340),
  ],
});

// companion_events 里的真实形状：被打断的流只有 delta、没有终结 message 事件；steer 后的新一轮
// 先流式（turnId t5）再落 message 事件收编；停止那轮（r2）只有 delta + agent_cancelled。
const coldEvents = (): CompanionEvent[] => [
  ev('message', { id: 'u1', role: 'user', content: '帮我慢慢写', runId: 'r1' }, 101),
  delta('t3', 'R2-SLOW-s3 慢流第1段。', 'r1', 110),
  delta('t3', 'R2-SLOW-s3 慢流第2段。', 'r1', 120),
  // 插话：u2 进来，r1 的半段落库成 p3，流没有终点
  ev('message', { id: 'u2', role: 'user', content: 'R2-QUEUE-q1 赶上收尾的这句', runId: 'r1' }, 141),
  delta('t5', 'R2_OK 已收', 'r1', 200),
  delta('t5', '到：R2-QUEUE-q1 赶上收尾的这句', 'r1', 205),
  ev('message', { id: 'a2', role: 'assistant', content: reply, runId: 'r1' }, 210),
  ev('message', { id: 'u3', role: 'user', content: '再跑一个慢流', runId: 'r2' }, 301),
  delta('t4', 'R2-SLOW-s4 慢流第1段。', 'r2', 310),
  delta('t4', 'R2-SLOW-s4 慢流第2段。', 'r2', 320),
  ev('agent_cancelled', { runId: 'r2' }, 340),
];

function view(history: CompanionHistory | undefined, events: CompanionEvent[]) {
  return render(<CompanionConversation history={history} events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
    respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
}

/** .lan-messages 的直接子节点顺序：正文记文本，执行结果记 outcome。 */
function flow(container: HTMLElement) {
  return Array.from(container.querySelector('.lan-messages')!.children).map(node =>
    node.classList.contains('run-outcome') ? 'outcome' : node.querySelector('.assistant-text')?.textContent ?? node.textContent);
}

describe('被打断的流冷启动不重复（R4 验收 D2）', () => {
  afterEach(cleanup);

  it('冷启动与实时行数一致：半段只在历史位置出现一次，末尾没有重复块', () => {
    const cold = view(coldHistory(), coldEvents());
    const live = view(undefined, coldEvents());
    expect(flow(cold.container)).toEqual(flow(live.container));
    // 前提自证：这不是「两边都没画」，六个持久化形状各就各位，停止行也还在
    expect(flow(cold.container)).toEqual(['帮我慢慢写', partial3, 'R2-QUEUE-q1 赶上收尾的这句', reply, '再跑一个慢流', partial4, 'outcome']);
    // 重复块的形状是「慢流第1段」多出来——每个半段全文只出现一次
    expect(cold.container.textContent!.split('慢流第1段').length - 1).toBe(2);
  });

  it('Neo 头与实时一致：重复块以前不带头，现在半段回到历史位置照常该带头的带', () => {
    const cold = view(coldHistory(), coldEvents());
    const live = view(undefined, coldEvents());
    expect(cold.container.querySelectorAll('.assistant-label')).toHaveLength(3);
    expect(cold.container.querySelectorAll('.assistant-label')).toHaveLength(live.container.querySelectorAll('.assistant-label').length);
  });

  it('未被打断的正常流不受影响：流式 + 终结 message 事件照旧收编成一行', () => {
    const { container } = view({ sessionId: 's1', nextOffset: null, messages: [
      msg('u9', 'user', '一遍过', 100), msg('a9', 'assistant', '一遍过的回答。', 130),
    ] }, [
      ev('message', { id: 'u9', role: 'user', content: '一遍过', runId: 'r9' }, 101),
      delta('t9', '一遍过的回答', 'r9', 120),
      ev('message', { id: 'a9', role: 'assistant', content: '一遍过的回答。', runId: 'r9' }, 210),
    ]);
    expect(flow(container)).toEqual(['一遍过', '一遍过的回答。']);
  });

  it('真正仍在进行中的流冷启动仍显示', () => {
    const { container } = view({ sessionId: 's1', nextOffset: null, messages: [
      msg('u1', 'user', '先写一句', 100), msg('a1', 'assistant', '写好了。', 200),
    ] }, [
      ev('message', { id: 'u1', role: 'user', content: '先写一句', runId: 'r1' }, 101),
      ev('message', { id: 'a1', role: 'assistant', content: '写好了。', runId: 'r1' }, 201),
      ev('message', { id: 'u9', role: 'user', content: '再慢慢写', runId: 'r9' }, 500),
      delta('t9', 'R2-SLOW-s9 慢流第1段。', 'r9', 510),
    ]);
    expect(flow(container)).toEqual(['先写一句', '写好了。', '再慢慢写', 'R2-SLOW-s9 慢流第1段。']);
  });

  it('与更早历史消息同文的进行中流不被误删（落库时间早于流开始就不是它的半段）', () => {
    const sameText = 'AI 重新写了一遍。';
    const { container } = view({ sessionId: 's1', nextOffset: null, messages: [
      msg('u1', 'user', '重写', 100), msg('a1', 'assistant', sameText, 200),
    ] }, [
      ev('message', { id: 'u1', role: 'user', content: '重写', runId: 'r1' }, 101),
      ev('message', { id: 'a1', role: 'assistant', content: sameText, runId: 'r1' }, 201),
      ev('message', { id: 'u9', role: 'user', content: '再重写', runId: 'r9' }, 500),
      delta('t9', sameText, 'r9', 510),
    ]);
    expect(container.textContent!.split(sameText).length - 1).toBe(2);
  });
});
