import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageCard, PageContent } from '../../../src/renderer/components/features/shared/PageContent';

// PageContent/PageCard 布局契约（2026-07-27 UX 收尾 1.4）：
// 宽度二选一（全宽 / 居中 max-w-6xl）+ 统一 padding px-6 py-4 +
// 统一卡片语言 rounded-lg border-zinc-800 bg-zinc-900/70。
describe('PageContent', () => {
  it('默认全宽 + 统一 padding + 滚动容器', () => {
    const html = renderToStaticMarkup(<PageContent>content</PageContent>);
    expect(html).toContain('px-6 py-4');
    expect(html).toContain('overflow-y-auto');
    expect(html).not.toContain('max-w-6xl');
  });

  it('centered 变体加内层 max-w-6xl 居中包裹，滚动条仍贴窗口边缘', () => {
    const html = renderToStaticMarkup(<PageContent width="centered" innerClassName="gap-4">content</PageContent>);
    expect(html).toContain('mx-auto');
    expect(html).toContain('max-w-6xl');
    expect(html).toContain('gap-4');
    expect(html).toContain('overflow-y-auto');
  });

  it('scroll/padding 关闭时转为全 bleed flex 容器（嵌入面板自管布局）', () => {
    const html = renderToStaticMarkup(<PageContent scroll={false} padding={false}>content</PageContent>);
    expect(html).not.toContain('overflow-y-auto');
    expect(html).toContain('overflow-hidden');
    expect(html).not.toContain('px-6');
  });

  it('透传 id/role/testId 等容器属性（tabpanel 语义不丢）', () => {
    const html = renderToStaticMarkup(
      <PageContent id="panel" role="tabpanel" testId="my-panel">content</PageContent>,
    );
    expect(html).toContain('id="panel"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('data-testid="my-panel"');
  });
});

describe('PageCard', () => {
  it('统一卡片语言 + header（icon/title/actions）+ body', () => {
    const html = renderToStaticMarkup(
      <PageCard title="标题" icon={<span>i</span>} actions={<span>a</span>}>body</PageCard>,
    );
    expect(html).toContain('rounded-lg border border-zinc-800 bg-zinc-900/70');
    expect(html).toContain('标题');
    expect(html).toContain('p-4');
  });

  it('无 title/actions 时不渲染 header 行', () => {
    const html = renderToStaticMarkup(<PageCard>body</PageCard>);
    expect(html).not.toContain('border-b border-zinc-800');
  });
});
