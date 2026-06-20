import { describe, expect, it } from 'vitest';
import {
  injectSelectionScript,
  injectPreviewStyle,
  parseProtoSelectMessage,
  PROTO_SELECT_SOURCE,
  PROTO_SELECT_MESSAGE,
} from '../../../src/renderer/components/design/designPreviewInject';

describe('injectSelectionScript', () => {
  it('关闭时原样返回', () => {
    const html = '<html><body><h1>x</h1></body></html>';
    expect(injectSelectionScript(html, false)).toBe(html);
  });

  it('开启时把脚本插在 </body> 前', () => {
    const out = injectSelectionScript('<html><body><h1>x</h1></body></html>', true);
    expect(out).toContain('data-neo-design-select');
    expect(out).toContain(PROTO_SELECT_MESSAGE);
    expect(out.indexOf('data-neo-design-select')).toBeLessThan(out.indexOf('</body>'));
  });

  it('无 body 时附到末尾', () => {
    const out = injectSelectionScript('<div>x</div>', true);
    expect(out.startsWith('<div>x</div>')).toBe(true);
    expect(out).toContain('data-neo-design-select');
  });
});

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

describe('parseProtoSelectMessage', () => {
  const valid = {
    source: PROTO_SELECT_SOURCE,
    type: PROTO_SELECT_MESSAGE,
    payload: { tag: 'button', text: '购买', selector: '.cta' },
  };

  it('合法消息解析出载荷', () => {
    expect(parseProtoSelectMessage(valid)).toEqual({ tag: 'button', text: '购买', selector: '.cta' });
  });

  it('来源/类型不符或缺 selector 返回 null', () => {
    expect(parseProtoSelectMessage(null)).toBeNull();
    expect(parseProtoSelectMessage({ ...valid, source: 'evil' })).toBeNull();
    expect(parseProtoSelectMessage({ ...valid, type: 'other' })).toBeNull();
    expect(parseProtoSelectMessage({ source: PROTO_SELECT_SOURCE, type: PROTO_SELECT_MESSAGE, payload: {} })).toBeNull();
  });
});
