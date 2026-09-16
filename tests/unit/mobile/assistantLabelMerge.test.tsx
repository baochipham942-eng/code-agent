// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionHistory } from '../../../src/shared/contract/companionLibrary';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

const text = messages('zh');
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>) => ({ eventId: `e${++seq}`, epoch: 1, seq, sessionId: 's1', kind, payload, createdAt: seq }) as unknown as CompanionEvent;
const user = (id: string, content: string, runId = 'r1') => ev('message', { id, role: 'user', content, runId });
const reply = (id: string, content: string, runId = 'r1') => ev('message', { id, role: 'assistant', content, runId });

function view(events: CompanionEvent[], history?: CompanionHistory) {
  return render(<CompanionConversation events={events} history={history} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
    respond={vi.fn(async () => {})} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
}

/** 时间线里每条助手行：带头的记成「Neo:正文」，不带头的只记正文。 */
function lines(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.lan-message:not(.from-user)')).map(row =>
    `${row.querySelector('.assistant-label') ? 'Neo:' : ''}${row.querySelector('.assistant-text')!.textContent}`);
}

describe('Neo 头一段只画一次（N-MOBILE-ASSISTANT-LABEL-MERGE，爸 09-17 ③A）', () => {
  afterEach(cleanup);

  it('连续两段助手正文只在第一段画头', () => {
    const { container } = view([user('u1', '你好'), reply('a1', '第一段'), reply('a2', '第二段')]);
    expect(lines(container)).toEqual(['Neo:第一段', '第二段']);
  });

  it('中间隔着审批卡也不重画', () => {
    const { container } = view([user('u1', '写个文件'), reply('a1', '我先写'),
      ev('approval', { requestId: 'p1', sessionId: 's1', revision: 1, status: 'approved', kind: 'approval' }), reply('a2', '写好了')]);
    expect(container.querySelector('.approval-card')).not.toBeNull();
    expect(lines(container)).toEqual(['Neo:我先写', '写好了']);
  });

  it('中间隔着执行结果行也不重画', () => {
    const { container } = view([user('u1', '跑一下'), reply('a1', '开始了', 'r1'), ev('agent_cancelled', { runId: 'r1' }), reply('a2', '接着说', 'r2')]);
    expect(container.querySelector('.run-outcome')).not.toBeNull();
    expect(lines(container)).toEqual(['Neo:开始了', '接着说']);
  });

  it('计划批准后的第二次执行不重画', () => {
    const { container } = view([user('u1', '做个计划'), reply('a1', '计划如下', 'r1'),
      ev('plan', { requestId: 'plan-1', sessionId: 's1', status: 'approved', runId: 'r1' }), reply('a2', '按计划做完了', 'r2')]);
    expect(lines(container)).toEqual(['Neo:计划如下', '按计划做完了']);
  });

  it('空正文的助手行不算第一段，头画在之后第一段有正文的行上', () => {
    const { container } = view([user('u1', '派个子助手'), reply('a0', ''), reply('a1', '交给后台了'), reply('a2', '好了')]);
    expect(lines(container)).toEqual(['Neo:交给后台了', '好了']);
  });

  it('用户再说一句后，下一段重新画头', () => {
    const { container } = view([user('u1', '一'), reply('a1', '回一'), reply('a2', '补一'), user('u2', '二'), reply('a3', '回二')]);
    expect(lines(container)).toEqual(['Neo:回一', '补一', 'Neo:回二']);
  });

  it('实时流式（提交时换 key）与冷启动历史结果一致', () => {
    const history: CompanionHistory = { messages: [
      { id: 'u1', role: 'user', content: '对比一下' }, { id: 'a1', role: 'assistant', content: '我先查' },
      { id: 'a2', role: 'assistant', content: '查好了' }, { id: 'u2', role: 'user', content: '再说说' }, { id: 'a3', role: 'assistant', content: '好' },
    ] } as unknown as CompanionHistory;
    const cold = lines(view([], history).container);
    cleanup();
    const live = [user('u1', '对比一下'),
      ev('message_delta', { runId: 'r1', turnId: 't1', op: 'append', text: '我先' })];
    const streaming = view(live);
    // 流到一半：流式行自己就是这一段的第一段，头已经在
    expect(lines(streaming.container)).toEqual(['Neo:我先']);
    live.push(ev('message_delta', { runId: 'r1', turnId: 't1', op: 'append', text: '查' }), reply('a1', '我先查'),
      ev('approval', { requestId: 'p1', sessionId: 's1', revision: 1, status: 'approved', kind: 'approval' }),
      ev('message_delta', { runId: 'r1', turnId: 't2', op: 'append', text: '查好了' }), reply('a2', '查好了'),
      user('u2', '再说说', 'r2'), ev('message_delta', { runId: 'r2', turnId: 't3', op: 'append', text: '好' }), reply('a3', '好', 'r2'));
    streaming.rerender(<CompanionConversation events={[...live]} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
      respond={vi.fn(async () => {})} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
    expect(lines(streaming.container)).toEqual(['Neo:我先查', '查好了', 'Neo:好']);
    expect(lines(streaming.container)).toEqual(cold);
  });
});
