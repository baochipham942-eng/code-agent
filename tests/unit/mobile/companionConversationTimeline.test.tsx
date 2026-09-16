// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

const text = messages('zh');
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>) => ({ eventId: `e${++seq}`, epoch: 1, seq, sessionId: 's1', kind, payload, createdAt: seq }) as unknown as CompanionEvent;

// 取自爸 2026-09-16 22:35 真机那一轮在宿主 companion_events 里的真实形状（run-b3d2c1b5）：
// 先说一句 → 只调 spawn_agent 的空正文 → 子助手写文件要审批 → 爸允许 → 只调 Read 的空正文 → 最终回复
const events = [
  ev('message', { id: 'u1', role: 'user', content: '对比一下 iphone17 和 pixel 10', runId: 'r1' }),
  ev('message', { id: 'a1', role: 'assistant', content: '我先把这件事交给后台执行。', runId: 'r1' }),
  ev('message', { id: 'a2', role: 'assistant', content: '', runId: 'r1' }),
  ev('approval', { requestId: 'perm-1', sessionId: 's1', revision: 1, status: 'pending', kind: 'approval', preview: JSON.stringify({ type: 'file_write', details: { path: '/tmp/x.md' } }) }),
  ev('approval', { requestId: 'perm-1', sessionId: 's1', revision: 1, status: 'approved', kind: 'approval' }),
  ev('message', { id: 'a3', role: 'assistant', content: '', runId: 'r1' }),
  ev('message', { id: 'a4', role: 'assistant', content: '对比报告在这里。', runId: 'r1' }),
];

function view() {
  return render(<CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
    respond={vi.fn(async () => {})} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
}

describe('手机会话时间线（爸 2026-09-16 build 49 真机）', () => {
  afterEach(cleanup);

  it('只调了工具的空正文助手消息不画成空气泡', () => {
    const { container } = view();
    // 前提自证：两条有正文的助手消息确实渲染了
    expect(container.textContent).toContain('我先把这件事交给后台执行。');
    expect(container.textContent).toContain('对比报告在这里。');
    // 两段有正文的回复之间隔着审批卡：Neo 头一段只画一次（爸 09-17 ③A），见 assistantLabelMerge.test.tsx
    const labels = container.querySelectorAll('.assistant-label');
    expect(labels).toHaveLength(1);
    for (const bubble of container.querySelectorAll('.lan-message:not(.from-user)')) expect(bubble.textContent!.replace(text.neo, '').trim()).not.toBe('');
  });

  it('审批卡按出现时刻插在时间线里，之后到的回复排在卡片下面；允许后说「已允许」', () => {
    const { container } = view();
    const flow = Array.from(container.querySelector('.lan-messages')!.children).map(node =>
      node.classList.contains('approval-card') ? 'card' : node.textContent!.includes('对比报告在这里') ? 'final' : node.textContent!.includes('交给后台') ? 'first' : null).filter(Boolean);
    expect(flow).toEqual(['first', 'card', 'final']);
    expect(container.querySelector('.approval-card [role="status"]')!.textContent).toBe(text.approvalApproved);
  });
});
