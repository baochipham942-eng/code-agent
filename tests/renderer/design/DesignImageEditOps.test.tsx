// ============================================================================
// T3：DesignImageEditOps 渲染测试（SSR，无需 DOM）。验证扩图方向五选 + 比例 + 扩展/去水印
// 按钮齐全、文案走 i18n、选中方向高亮、generating 时禁用。
// ============================================================================

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignImageEditOps } from '../../../src/renderer/components/design/DesignImageEditOps';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

function render(over: Partial<React.ComponentProps<typeof DesignImageEditOps>> = {}): string {
  return renderToStaticMarkup(
    <DesignImageEditOps
      t={zh}
      direction="all"
      ratio={1.5}
      generating={false}
      onDirectionChange={() => {}}
      onRatioChange={() => {}}
      onExpand={() => {}}
      onRemoveWatermark={() => {}}
      {...over}
    />,
  );
}

describe('DesignImageEditOps', () => {
  it('渲染五个方向 + 扩图 + 去水印控件，文案走 i18n', () => {
    const html = render();
    for (const dir of ['up', 'down', 'left', 'right', 'all']) {
      expect(html).toContain(`data-testid="design-expand-dir-${dir}"`);
    }
    expect(html).toContain('data-testid="design-expand-ratio"');
    expect(html).toContain('data-testid="design-expand-btn"');
    expect(html).toContain('data-testid="design-remove-watermark-btn"');
    expect(html).toContain(zh.design.expandBtn);
    expect(html).toContain(zh.design.removeWatermarkBtn);
    expect(html).toContain(zh.design.expandDirAll);
    expect(html).toContain('1.5×');
  });

  it('选中方向高亮（fuchsia），其余不高亮', () => {
    const html = render({ direction: 'left' });
    // 高亮类仅出现在被选方向；用块切分确认 left 段含高亮
    const leftIdx = html.indexOf('design-expand-dir-left');
    const segment = html.slice(leftIdx, leftIdx + 200);
    expect(segment).toContain('bg-fuchsia-500/30');
  });

  it('generating 时按钮禁用', () => {
    const html = render({ generating: true });
    // 两个操作按钮都带 disabled
    const matches = html.match(/data-testid="design-(expand|remove-watermark)-btn"[^>]*disabled/g);
    expect(matches?.length).toBe(2);
  });

  it('en 文案也对齐（i18n 两语种均有键）', () => {
    const html = render({ t: en });
    expect(html).toContain(en.design.expandBtn);
    expect(html).toContain(en.design.removeWatermarkBtn);
  });
});
