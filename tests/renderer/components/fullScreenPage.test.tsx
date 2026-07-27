// @vitest-environment jsdom
// 外壳默认档必须是 overlay（= 改版前行为）。
// 由来：批 C 改版时把注释写成「默认 overlay」但代码留在 inline，
// 结果设置页等根挂载页从整窗覆盖层变成主布局的 flex 子元素，被挤成下半屏（截图抓到）。
// 根挂载页不在右侧内容区里，inline 对它们就是坏的——默认档钉死在这里。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FullScreenPage, FullScreenPageHeader } from '../../../src/renderer/components/features/shared/FullScreenPage';

afterEach(cleanup);

describe('FullScreenPage 外壳契约', () => {
  it('不写 variant 时默认 overlay（整窗固定覆盖层）', () => {
    render(<FullScreenPage testId="probe">x</FullScreenPage>);
    const el = screen.getByTestId('probe');
    expect(el.getAttribute('data-page-variant')).toBe('overlay');
    expect(el.className).toContain('fixed');
    expect(el.className).toContain('inset-0');
  });

  it('variant="inline" 时不带固定定位，在内容区就地铺满', () => {
    render(<FullScreenPage testId="probe" variant="inline">x</FullScreenPage>);
    const el = screen.getByTestId('probe');
    expect(el.getAttribute('data-page-variant')).toBe('inline');
    expect(el.className).not.toContain('fixed');
    expect(el.className).toContain('flex-1');
  });

  it('header 省略 onClose 时不画返回按钮', () => {
    render(<FullScreenPageHeader icon={null} title="标题" />);
    expect(screen.queryByTestId('full-screen-page-back')).toBeNull();
  });

  it('header 给了 onClose 才画返回按钮，closeLabel 可改文案', () => {
    render(<FullScreenPageHeader icon={null} title="标题" onClose={() => {}} closeLabel="能力中心" />);
    expect(screen.getByTestId('full-screen-page-back').textContent).toContain('能力中心');
  });
});
