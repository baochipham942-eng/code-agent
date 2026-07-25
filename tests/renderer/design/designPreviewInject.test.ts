// 本文件原先还覆盖圈选 / 就地编辑 / 换肤色板那套 `neo-design:*` 协议
// （path()/injectSelectionScript/injectThemeOverride/PROTO_PALETTES/parseProto*Message）。
// 那些导出随宿主 DesignWorkspace.tsx（#621 退役全屏设计表单）成为残件，
// 已于 2026-07-25 孤儿能力审计一并删除，对应用例同批移除。
// 现在只剩仍在生产被消费的 injectPreviewStyle（VariantCompareView 等）。
import { describe, expect, it } from 'vitest';
import { injectPreviewStyle } from '../../../src/renderer/components/design/designPreviewInject';

describe('injectPreviewStyle', () => {
  it('把滚动条样式插在 <head> 起始处（原型样式可覆盖）', () => {
    const out = injectPreviewStyle('<html><head><title>x</title></head><body></body></html>');
    expect(out).toContain('data-neo-design-style');
    expect(out).toContain('scrollbar-width:thin');
    // 插在 head 起始 → 在已有 <title> 之前，页面后续样式能覆盖我们的默认值
    expect(out.indexOf('data-neo-design-style')).toBeLessThan(out.indexOf('<title>'));
  });

  it('无 head 时补一个 head', () => {
    const out = injectPreviewStyle('<html><body>x</body></html>');
    expect(out).toContain('<head>');
    expect(out).toContain('data-neo-design-style');
    expect(out.indexOf('data-neo-design-style')).toBeLessThan(out.indexOf('<body>'));
  });

  it('既无 head 也无 html 时前置', () => {
    const out = injectPreviewStyle('<div>x</div>');
    expect(out.startsWith('<style data-neo-design-style')).toBe(true);
  });
});
