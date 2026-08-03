// @vitest-environment jsdom
// ============================================================================
// EmptyState planet 可选属性（2026-08-02 星球品牌升级）：planet 是图标位的可选内容，
// 不是第 5 种变体——带 planet 时 34px PlanetSphere 替代 icon；不带时 4 变体行为零变化。
// PlanetSphere 在 jsdom 下走 canvas 兜底（空贴图 + 保底色），不应炸。
// ============================================================================

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from 'lucide-react';
import { EmptyState } from '../../../src/renderer/components/primitives/EmptyState';

describe('EmptyState planet 可选属性', () => {
  afterEach(() => cleanup());

  it('panel 变体带 planet 时在图标位渲染 34px 星球，icon 让位', () => {
    const { container } = render(
      <EmptyState variant="panel" icon={Database} planet={{ kind: 'jupiter' }} title="标题" text="文本" />,
    );
    const planet = container.querySelector('[data-planet="jupiter"]') as HTMLElement | null;
    expect(planet).toBeTruthy();
    expect(planet?.style.width).toBe('34px');
    // icon 让位：不再渲染 lucide svg
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('标题');
    expect(container.textContent).toContain('文本');
  });

  it('plain 变体同样支持 planet', () => {
    const { container } = render(
      <EmptyState variant="plain" planet={{ kind: 'earth' }} title="标题" text="文本" />,
    );
    expect(container.querySelector('[data-planet="earth"]')).toBeTruthy();
  });

  it('不带 planet 的 panel 变体行为零变化（icon 照常、无星球）', () => {
    const { container } = render(
      <EmptyState variant="panel" icon={Database} title="标题" text="文本" />,
    );
    expect(container.querySelector('[data-planet]')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('box/inline 没有图标位，planet 对它们不生效', () => {
    const { container: box } = render(<EmptyState variant="box" planet={{ kind: 'earth' }} text="文本" />);
    expect(box.querySelector('[data-planet]')).toBeNull();
    cleanup();
    const { container: inline } = render(<EmptyState variant="inline" planet={{ kind: 'sun' }} text="文本" />);
    expect(inline.querySelector('[data-planet]')).toBeNull();
  });
});
