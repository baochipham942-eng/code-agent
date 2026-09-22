// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { HistoryCache } from '../../../packages/mobile/src/platform/historyCache';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionHistory } from '../../../src/shared/contract/companionLibrary';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

// 形状取自 zj032 模拟器验收 raw-messages-full-timeline.csv（FB-177）：一轮 = 用户 → 只调工具的空正文 → 卡片 → 收尾回复。
const text = messages('zh');
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>, createdAt: number) => ({ eventId: `e${++seq}`, epoch: 1, seq, sessionId: 's1', kind, payload, createdAt }) as unknown as CompanionEvent;
const msg = (id: string, role: string, content: string, timestamp: number) => ({ id, role, content, timestamp });
const full = [
  msg('u1', 'user', '帮我写个文件', 100), msg('a1', 'assistant', '', 110), msg('a2', 'assistant', '写入后续消息', 200),
  msg('u2', 'user', '请问我', 300), msg('a3', 'assistant', '', 310), msg('a4', 'assistant', '已回答', 400),
  msg('u3', 'user', '慢任务', 500),
  msg('u4', 'user', '你好', 600), msg('a5', 'assistant', '已收到', 610),
];
const approval = (status: string, at: number) => ev('approval', { requestId: 'perm-1', sessionId: 's1', revision: 1, status, kind: 'approval' }, at);
const question = (status: string, at: number) => ev('question', { requestId: 'q-1', sessionId: 's1', revision: 1, status, kind: 'question', questions: [] }, at);

function view(history: CompanionHistory, events: CompanionEvent[]) {
  return render(<CompanionConversation history={history} events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
    respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
}
const page = (list: typeof full, nextOffset: number | null = null) => ({ sessionId: 's1', messages: list, nextOffset }) as CompanionHistory;

/** .lan-messages 的直接子节点顺序：卡片记 card:<aria-label>，执行结果记 outcome，消息记正文。 */
function flow(container: HTMLElement) {
  return Array.from(container.querySelector('.lan-messages')!.children).map(node =>
    node.classList.contains('approval-card') ? `card:${node.getAttribute('aria-label')}`
      : node.classList.contains('run-outcome') ? 'outcome'
        : node.querySelector('.assistant-text')?.textContent ?? node.textContent);
}

describe('冷启动卡片挂回原来那一轮（N-MOBILE-CARD-COLDSTART-ANCHOR / FB-177）', () => {
  afterEach(cleanup);

  it('冷启动：本机缓存的卡片排在 events 最前面，仍各自挂回发生时那一轮', () => {
    // 缓存里只有每张卡最新一版，createdAt 是第一次出现的时间（historyCache 保留）
    const { container } = view(page(full), [approval('approved', 150), question('approved', 350)]);
    expect(flow(container)).toEqual(['帮我写个文件', `card:${text.approval}`, '写入后续消息', '请问我', `card:${text.question}`, '已回答', '慢任务', '你好', '已收到']);
  });

  it('冷启动后宿主重放事件（消息、卡片、停止）追在缓存卡片后面：位置不变，执行结果仍在它那一轮', () => {
    const replay = [
      ev('message', { id: 'u1', role: 'user', content: '帮我写个文件', runId: 'r1' }, 101), approval('pending', 120), approval('approved', 150),
      ev('message', { id: 'a2', role: 'assistant', content: '写入后续消息', runId: 'r1' }, 201),
      ev('message', { id: 'u3', role: 'user', content: '慢任务', runId: 'r3' }, 501), ev('agent_cancelled', { runId: 'r3' }, 550),
      ev('message', { id: 'u4', role: 'user', content: '你好', runId: 'r4' }, 601),
    ];
    const { container } = view(page(full), [approval('approved', 120), question('approved', 350), ...replay]);
    expect(flow(container)).toEqual(['帮我写个文件', `card:${text.approval}`, '写入后续消息', '请问我', `card:${text.question}`, '已回答', '慢任务', 'outcome', '你好', '已收到']);
  });

  it('宿主事件日志已裁掉那一轮的消息事件、只剩停止事件时，执行结果仍按时间挂回那一轮', () => {
    const { container } = view(page(full), [ev('agent_cancelled', { runId: 'r3' }, 550)]);
    expect(flow(container).slice(-4)).toEqual(['慢任务', 'outcome', '你好', '已收到']);
  });

  it('实时不回退：历史之后到的事件照旧挂在当时最后一行下面', () => {
    const live = [
      ev('message', { id: 'u9', role: 'user', content: '再写一个', runId: 'r9' }, 700),
      ev('message', { id: 'a9', role: 'assistant', content: '我先写', runId: 'r9' }, 710),
      ev('approval', { requestId: 'perm-9', sessionId: 's1', revision: 1, status: 'pending', kind: 'approval' }, 720),
      ev('message', { id: 'a10', role: 'assistant', content: '写好了', runId: 'r9' }, 800),
      ev('error', { runId: 'r9', code: 'X' }, 810),
    ];
    const { container } = view(page(full), live);
    expect(flow(container).slice(-6)).toEqual(['已收到', '再写一个', '我先写', `card:${text.approval}`, '写好了', 'outcome']);
  });

  it('历史分页：卡片早于第一页时先挂在最前面，loadMore 翻到那一轮后挂回原位', () => {
    const cards = [approval('approved', 150)];
    const first = view(page(full.slice(3), 3), cards);
    expect(flow(first.container)).toEqual([text.loadHistory, `card:${text.approval}`, '请问我', '已回答', '慢任务', '你好', '已收到']);
    first.rerender(<CompanionConversation history={page(full)} events={cards} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
      respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
    expect(flow(first.container).slice(0, 3)).toEqual(['帮我写个文件', `card:${text.approval}`, '写入后续消息']);
  });

  it('本机缓存同一张卡只留最新一版，但保留第一次出现的 createdAt', () => {
    const cache = new HistoryCache();
    cache.ingestEvents([approval('pending', 120)]);
    cache.ingestEvents([approval('closed', 9000)]);
    const [card] = cache.snapshot().events;
    expect(card.payload.status).toBe('closed');
    expect(card.createdAt).toBe(120);
  });
});
