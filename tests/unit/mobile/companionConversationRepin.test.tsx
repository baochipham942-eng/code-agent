// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');

// jsdom 不做布局（scrollHeight 恒 0），所以这里只钉**接线**：输入区那一层高度一变，
// 贴底的人要重新贴一次。几何那一半由 scripts/acceptance/mobile-composer-overlay-layer.tsx
// 在真引擎里量（两条是一条判据的两半，缺一不可）。
//
// events / history 必须是**稳定引用**：写成行内字面量的话每次 rerender 都是新对象，
// 「跟到底」那个副作用本来就会重跑，composerHeight 加不加进依赖都绿——
// 第一版判据就是这么空转的（变异没转红才发现）。
const events: never[] = [];
const history = { sessionId: 's1', messages: [{ id: 'm1', role: 'user', content: '在' }], nextOffset: null } as never;
const respond = vi.fn(async () => {});

function view(composerHeight: number) {
  return <CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} history={history}
    loadMore={() => {}} disabled={false} respond={respond} openArtifact={() => {}} composerHeight={composerHeight} />;
}

function mount(composerHeight: number) {
  const rendered = render(view(composerHeight));
  const scroller = document.querySelector('.lan-messages') as HTMLDivElement;
  Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
  return { rendered, scroller };
}

describe('输入区那一层长高矮时，贴底的人要重新贴底（N-COMPOSER-TRACE-JITTER 验收②）', () => {
  afterEach(cleanup);

  it('只有 composerHeight 变了也要重新贴底', () => {
    const { rendered, scroller } = mount(120);
    scroller.scrollTop = 0;
    rendered.rerender(view(213));
    expect(scroller.scrollTop).toBe(5000);
  });

  it('同一个高度重渲染不做多余的事', () => {
    const { rendered, scroller } = mount(120);
    scroller.scrollTop = 0;
    rendered.rerender(view(120));
    expect(scroller.scrollTop).toBe(0);
  });

  it('没跟到底的人不许被拽下去——滚上去看历史时输入区长高不该把他拉回底部', () => {
    const { rendered, scroller } = mount(120);
    // 距底 4400px，远超「<80px 算贴底」的判据：用户正在看历史
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    rendered.rerender(view(213));
    expect(scroller.scrollTop).toBe(0);
  });
});
