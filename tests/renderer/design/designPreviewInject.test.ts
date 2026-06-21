import { describe, expect, it } from 'vitest';
import {
  injectSelectionScript,
  injectPreviewStyle,
  injectThemeOverride,
  parseProtoSelectMessage,
  PROTO_PALETTES,
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

describe('PROTO_PALETTES', () => {
  it('提供 5 套色板，首个是原色（零偏移）', () => {
    expect(PROTO_PALETTES).toHaveLength(5);
    expect(PROTO_PALETTES[0]).toMatchObject({ id: 'original', deg: 0 });
    // id 唯一
    expect(new Set(PROTO_PALETTES.map((p) => p.id)).size).toBe(5);
  });
});

describe('injectThemeOverride', () => {
  const html = '<html><head><title>x</title></head><body><img src="https://picsum.photos/seed/a/400/300"></body></html>';

  it('原色（deg 0）原样返回，不注入', () => {
    expect(injectThemeOverride(html, 'original')).toBe(html);
  });

  it('未知色板原样返回', () => {
    expect(injectThemeOverride(html, 'nope')).toBe(html);
  });

  it('彩色色板注入 hue-rotate 覆盖样式（插在 </head> 前，赢过原型样式）', () => {
    const ocean = PROTO_PALETTES.find((p) => p.id === 'ocean');
    expect(ocean).toBeTruthy();
    const out = injectThemeOverride(html, 'ocean');
    expect(out).toContain('data-neo-design-theme');
    expect(out).toContain(`hue-rotate(${ocean?.deg}deg)`);
    // 图片反向旋转回原色，seed 真图不被染色
    expect(out).toContain(`hue-rotate(${-(ocean?.deg ?? 0)}deg)`);
    expect(out).toContain('img');
    // 注入在 head 末尾（在 <title> 之后），样式覆盖原型既有规则
    expect(out.indexOf('data-neo-design-theme')).toBeGreaterThan(out.indexOf('<title>'));
    expect(out.indexOf('data-neo-design-theme')).toBeLessThan(out.indexOf('</head>'));
  });

  it('无 head 时插在 </body> 前', () => {
    const out = injectThemeOverride('<body><div>x</div></body>', 'ocean');
    expect(out).toContain('data-neo-design-theme');
    expect(out.indexOf('data-neo-design-theme')).toBeLessThan(out.indexOf('</body>'));
  });

  it('既无 head 也无 body 时附到末尾', () => {
    const out = injectThemeOverride('<div>x</div>', 'ocean');
    expect(out.startsWith('<div>x</div>')).toBe(true);
    expect(out).toContain('data-neo-design-theme');
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
