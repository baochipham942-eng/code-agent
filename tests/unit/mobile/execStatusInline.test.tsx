// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages, runOutcomeCopy } from '../../../packages/mobile/src/i18n';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

const text = messages('zh');
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>) => ({ eventId: `e${++seq}`, sessionId: 's1', kind, payload }) as unknown as CompanionEvent;

function view(events: CompanionEvent[], running: { stop(): void; stopDisabled: boolean } | null = null) {
  return <CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
    respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} running={running} />;
}

/** 滚动区里按文档顺序排的「消息 / 终态行 / 执行条」，其余元素不看。 */
function stream(): string[] {
  const scroller = document.querySelector('.lan-messages')!;
  return Array.from(scroller.children).flatMap(node => {
    if (node.classList.contains('run-outcome')) return [`outcome:${node.textContent}`];
    if (node.classList.contains('run-strip')) return ['run-strip'];
    if (node.classList.contains('from-user')) return [`user:${node.textContent}`];
    if (node.classList.contains('lan-message')) return [`neo:${node.querySelector('.assistant-text')?.textContent}`];
    return [];
  });
}

describe('执行状态挂在对应那次执行下面（N-MOBILE-EXEC-STATUS ①②）', () => {
  afterEach(cleanup);

  it('两次任务一败一成：失败挂在它那次回复下面，成功不挂行（爸 09-16 build 41）', () => {
    render(view([
      ev('message', { id: 'u1', role: 'user', content: '做表', runId: 'r1' }),
      ev('message', { id: 'a1', role: 'assistant', content: '开始', runId: 'r1' }),
      ev('error', { code: 'MODEL_AUTH', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
      ev('message', { id: 'u2', role: 'user', content: '再试', runId: 'r2' }),
      ev('message', { id: 'a2', role: 'assistant', content: '好了', runId: 'r2' }),
      ev('agent_complete', { runId: 'r2' }),
    ]));
    expect(stream()).toEqual([
      'user:做表', 'neo:开始', `outcome:${runOutcomeCopy(text, 'failed', 'MODEL_AUTH')}`,
      'user:再试', 'neo:好了',
    ]);
  });

  it('只成功的一轮：回复下面什么都不挂——回复本身就是成功的证据', () => {
    render(view([
      ev('message', { id: 'u1', role: 'user', content: '你好', runId: 'r1' }),
      ev('message', { id: 'a1', role: 'assistant', content: '你好，有什么可以帮你的？', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['user:你好', 'neo:你好，有什么可以帮你的？']);
    expect(document.querySelector('.run-outcome')).toBeNull();
  });

  it('失败行带原因；同一次执行先报错后收尾，失败说了算', () => {
    render(view([
      ev('message', { id: 'a1', role: 'assistant', content: '处理中', runId: 'r1' }),
      ev('error', { code: 'RUN_FAILED', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['neo:处理中', `outcome:${text.failed}：${text.runFailed}`]);
  });

  it('流式回复中途结束、正式消息后到：终态跟着换成正式那一行，不丢也不落到底部', () => {
    render(view([
      ev('message', { id: 'u1', role: 'user', content: '写', runId: 'r1' }),
      ev('message_snapshot', { content: '草', turnId: 't1', runId: 'r1' }),
      ev('agent_cancelled', { runId: 'r1' }),
      ev('message', { id: 'a1', role: 'assistant', content: '草稿', runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['user:写', 'neo:草稿', `outcome:${text.stopped}`]);
  });

  it('处理中：执行条在最后一条下面，带停止；任务结束（running=null）即消失', () => {
    const stop = vi.fn();
    const events = [ev('message', { id: 'u1', role: 'user', content: '跑', runId: 'r1' })];
    const rendered = render(view(events, { stop, stopDisabled: false }));
    expect(stream()).toEqual(['user:跑', 'run-strip']);
    const strip = document.querySelector('[data-testid="run-strip"]')!;
    expect(strip.textContent).toContain(text.running);
    fireEvent.click(strip.querySelector('button')!);
    expect(stop).toHaveBeenCalledTimes(1);
    rendered.rerender(view(events, null));
    expect(document.querySelector('[data-testid="run-strip"]')).toBeNull();
  });
});
