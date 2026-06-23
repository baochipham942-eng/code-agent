// DiagramToolbar 真组件渲染回归（renderToStaticMarkup，走真 useI18n→appStore 默认 zh）。
// 验证：7 个工具 + 调色板 + 删除按钮条件渲染 + 当前工具高亮(aria-pressed) + i18n 文案。
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagramToolbar } from '../../../src/renderer/components/design/DiagramToolbar';
import { DIAGRAM_PALETTE } from '../../../src/renderer/components/design/designDiagramTypes';

const render = (over: Partial<React.ComponentProps<typeof DiagramToolbar>> = {}): string =>
  renderToStaticMarkup(
    React.createElement(DiagramToolbar, {
      tool: 'select',
      onToolChange: () => {},
      color: DIAGRAM_PALETTE[0],
      onColorChange: () => {},
      canDelete: false,
      onDelete: () => {},
      ...over,
    }),
  );

describe('DiagramToolbar', () => {
  it('渲染全部 7 个工具 + 调色板 swatch', () => {
    const html = render();
    for (const tool of ['select', 'connect', 'rect', 'ellipse', 'line', 'text', 'sticky']) {
      expect(html).toContain(`data-tool="${tool}"`);
    }
    for (const c of DIAGRAM_PALETTE) {
      expect(html).toContain(`data-color="${c}"`);
    }
  });

  it('当前工具高亮 aria-pressed=true，其余 false', () => {
    const html = render({ tool: 'rect' });
    // rect 按钮 aria-pressed=true
    expect(html).toMatch(/data-tool="rect"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-tool="rect"/);
    // select 按钮 aria-pressed=false
    expect(html).toMatch(/data-tool="select"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-tool="select"/);
  });

  it('canDelete=false 时不渲染删除按钮', () => {
    expect(render({ canDelete: false })).not.toContain('diagram-delete');
  });

  it('canDelete=true 时渲染删除按钮', () => {
    expect(render({ canDelete: true })).toContain('data-testid="diagram-delete"');
  });

  it('i18n 文案解析（默认 zh）', () => {
    const html = render();
    expect(html).toContain('选择'); // diagramSelect
    expect(html).toContain('连线'); // diagramConnect
    expect(html).toContain('便签'); // diagramSticky
  });
});
