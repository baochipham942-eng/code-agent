import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VariantCompareView } from '../../../src/renderer/components/design/VariantCompareView';
import { zh } from '../../../src/renderer/i18n/zh';
import type { Variant } from '../../../src/renderer/components/design/variantSpine';

const canvasVariant = (over: Partial<Variant> = {}): Variant => ({
  id: 'a',
  kind: 'canvas-image',
  pinned: false,
  discarded: false,
  createdAt: 1,
  payload: { src: 'assets/gen-1.png', x: 0, y: 0, width: 100, height: 100 },
  ...over,
});

const protoVariant = (over: Partial<Variant> = {}): Variant => ({
  id: 'p',
  kind: 'proto-html',
  pinned: false,
  discarded: false,
  createdAt: 2,
  payload: { htmlPath: '/run/versions/v-2.html' },
  ...over,
});

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('VariantCompareView', () => {
  it('并排渲染两版 + 标题 + 每版各一组设主版/淘汰按钮', () => {
    const html = render(
      <VariantCompareView
        variantA={canvasVariant()}
        variantB={canvasVariant({ id: 'b', parentId: 'a' })}
        runDir="/run"
        onPin={() => undefined}
        onDiscard={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain(zh.design.compareTitle);
    // 两版各一个「设为主版」「淘汰」
    expect(html.split(zh.design.setMainVersion)).toHaveLength(3);
    expect(html.split(zh.design.discardVersion)).toHaveLength(3);
  });

  it('pinned 版显示主版徽标', () => {
    const html = render(
      <VariantCompareView
        variantA={canvasVariant({ pinned: true })}
        variantB={canvasVariant({ id: 'b' })}
        runDir="/run"
        onPin={() => undefined}
        onDiscard={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain(zh.design.mainVersion);
  });

  it('proto-html 与 canvas-image 都能渲染（label 回退按 kind/op）', () => {
    const html = render(
      <VariantCompareView
        variantA={protoVariant({ op: 'continueEdit' })}
        variantB={protoVariant({ id: 'p2', label: '加 FAQ 区块' })}
        runDir="/run"
        onPin={() => undefined}
        onDiscard={() => undefined}
        onClose={() => undefined}
      />,
    );
    // 有 label 的显示 label；无 label 的 proto+continueEdit 回退到「续编」
    expect(html).toContain('加 FAQ 区块');
    expect(html).toContain(zh.design.continueEditTitle);
  });
});
