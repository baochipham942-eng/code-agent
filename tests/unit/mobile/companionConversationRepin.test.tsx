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
    loadMore={() => {}} disabled={false} respond={respond} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} composerHeight={composerHeight} />;
}

/** jsdom 不排版：内容下沿（最后一个元素的 rect.bottom）要手工给。 */
function mount(composerHeight: number, geometry = { scrollHeight: 5000, contentBottom: 4900 }) {
  const rendered = render(view(composerHeight));
  const scroller = document.querySelector('.lan-messages') as HTMLDivElement;
  Object.defineProperty(scroller, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(scroller.lastElementChild!, 'getBoundingClientRect', {
    value: () => ({ top: 0, bottom: geometry.contentBottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }),
    configurable: true,
  });
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

// build 40 真机：进会话第一条上半被顶栏裁掉。贴底把 scrollTop 拉到 scrollHeight，而 scrollHeight 里算着
// 最后一条的下外边距和给输入区留的底部留白——内容本身放得下时，贴底会把第一条推出可视区顶上。
describe('整段放得下时从顶部排，第一条完整可见（N-MOBILE-EXEC-STATUS ③）', () => {
  afterEach(cleanup);

  it('内容下沿在输入区那一层之上：scrollTop 停在 0，不贴底', () => {
    // 可视 600，输入区 150 ⇒ 输入区之上 450；内容下沿 420 放得下，但加上留白 scrollHeight 是 640，贴底会上推 40px
    // rect 是视口坐标、会随滚动移动；mock 不会，所以从 scrollTop=0 起算才自洽
    const { rendered, scroller } = mount(120, { scrollHeight: 640, contentBottom: 420 });
    scroller.scrollTop = 0;
    rendered.rerender(view(150));
    expect(scroller.scrollTop).toBe(0);
  });

  it('内容真的放不下：照旧贴底，最新那条在输入区上面', () => {
    const { rendered, scroller } = mount(120, { scrollHeight: 900, contentBottom: 700 });
    scroller.scrollTop = 0;
    rendered.rerender(view(150));
    expect(scroller.scrollTop).toBe(900);
  });

  it('输入区还没量到高度（0）时不判，照旧贴底', () => {
    const { rendered, scroller } = mount(120, { scrollHeight: 640, contentBottom: 420 });
    scroller.scrollTop = 0;
    rendered.rerender(view(0));
    expect(scroller.scrollTop).toBe(640);
  });
});
