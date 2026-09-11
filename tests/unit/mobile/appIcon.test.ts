import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppIcon } from '../../../packages/mobile/src/app/AppIcon';

// 图标契约真源：docs/features/neo-mobile-companion/design.html 的 ICONS 映射（私档）。
// 这里钉死每条路径与描边参数，改设计稿时要同步改这里，防止实现悄悄漂移回自绘/字符图标。
const DESIGN_PATHS = {
  menu: 'M4 8h16M4 15h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  back: 'm15 18-6-6 6-6',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM10 2h4l1 3 3 2 3 1v4l-2 3-1 3-3 1-1 3h-4l-1-3-3-1-2-3-2-3V8l3-1 3-2Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4M9 22h6',
  stop: 'M7 7h10v10H7z',
} as const;

describe('AppIcon（对齐 design.html 图标契约）', () => {
  for (const [name, d] of Object.entries(DESIGN_PATHS)) {
    it(`${name} 渲染设计稿路径`, () => {
      const html = renderToStaticMarkup(createElement(AppIcon, { name: name as keyof typeof DESIGN_PATHS }));
      expect(html).toContain('stroke-width="1.7"');
      expect(html).toContain(`d="${d}"`);
      expect(html).toContain('stroke-linecap="round"');
      expect(html).toContain('aria-hidden="true"');
    });
  }

  it('不渲染字符字形（emoji/文本符号回退）', () => {
    for (const name of Object.keys(DESIGN_PATHS) as (keyof typeof DESIGN_PATHS)[]) {
      const html = renderToStaticMarkup(createElement(AppIcon, { name }));
      expect(html).not.toMatch(/[☰↑＋⚙✓›×■]|···/);
    }
  });
});
