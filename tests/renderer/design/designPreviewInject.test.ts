import { describe, expect, it } from 'vitest';
import {
  injectSelectionScript,
  injectInlineEditScript,
  injectPreviewStyle,
  injectThemeOverride,
  parseProtoSelectMessage,
  parseProtoTextEditMessage,
  PATH_FN_SOURCE,
  PROTO_PALETTES,
  PROTO_SELECT_SOURCE,
  PROTO_SELECT_MESSAGE,
  PROTO_TEXT_EDIT_MESSAGE,
} from '../../../src/renderer/components/design/designPreviewInject';

// PATH_FN_SOURCE 是注入到 iframe 的字符串（无法 import，node 无 DOM），这里用极小的 fake
// 元素树在 node 里 eval 出 path()，验证「总是带 nth-child」(FIX 3c)。
function makePath(): (el: unknown) => string {
  const factory = new Function(`${PATH_FN_SOURCE}\nreturn path;`) as () => (el: unknown) => string;
  return factory();
}
type FakeEl = {
  nodeType: number;
  tagName: string;
  id?: string;
  classList: string[];
  parentNode?: FakeEl | null;
  parentElement?: FakeEl | null;
  children: FakeEl[];
};
function el(tagName: string, opts: Partial<FakeEl> = {}): FakeEl {
  return {
    nodeType: 1,
    tagName,
    classList: [],
    children: [],
    parentNode: null,
    parentElement: null,
    ...opts,
  } as FakeEl;
}
function link(parent: FakeEl, kids: FakeEl[]): FakeEl {
  parent.children = kids;
  kids.forEach((k) => {
    k.parentNode = parent;
    k.parentElement = parent;
  });
  return parent;
}

describe('path() (注入脚本 selector 计算)', () => {
  it('始终给每段追加 :nth-child（即便有 class）', () => {
    const path = makePath();
    const body = el('BODY');
    const ul = el('UL', { classList: ['list'] });
    const li1 = el('LI', { classList: ['row'] });
    const li2 = el('LI', { classList: ['row'] });
    link(body, [ul]);
    link(ul, [li1, li2]);

    const sel1 = path(li1);
    const sel2 = path(li2);
    // 两个同 tag 同 class 兄弟必须算出不同 selector（位置区分）
    expect(sel1).not.toBe(sel2);
    expect(sel1).toContain('li.row:nth-child(1)');
    expect(sel2).toContain('li.row:nth-child(2)');
    // ul 段也带 nth-child（即便有 class）
    expect(sel1).toContain('ul.list:nth-child(1)');
  });

  it('有 id 时短路返回 #id', () => {
    const path = makePath();
    expect(path(el('DIV', { id: 'hero' }))).toBe('#hero');
  });
});

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

  it('不把就地编辑消息误认成圈选消息（类型隔离）', () => {
    const editMsg = {
      source: PROTO_SELECT_SOURCE,
      type: PROTO_TEXT_EDIT_MESSAGE,
      payload: { selector: '#t', newText: 'x' },
    };
    expect(parseProtoSelectMessage(editMsg)).toBeNull();
  });
});

describe('injectInlineEditScript', () => {
  it('关闭时原样返回', () => {
    const html = '<html><body><h1>x</h1></body></html>';
    expect(injectInlineEditScript(html, false)).toBe(html);
  });

  it('开启时把脚本插在 </body> 前', () => {
    const out = injectInlineEditScript('<html><body><h1>x</h1></body></html>', true);
    expect(out).toContain('data-neo-design-inline-edit');
    expect(out).toContain(PROTO_TEXT_EDIT_MESSAGE);
    expect(out).toContain('contenteditable');
    expect(out.indexOf('data-neo-design-inline-edit')).toBeLessThan(out.indexOf('</body>'));
  });

  it('无 body 时附到末尾', () => {
    const out = injectInlineEditScript('<div>x</div>', true);
    expect(out.startsWith('<div>x</div>')).toBe(true);
    expect(out).toContain('data-neo-design-inline-edit');
  });

  it('脚本限制只编辑叶子文本元素（含 isLeaf 守卫，children.length===0）', () => {
    const out = injectInlineEditScript('<html><body><h1>x</h1></body></html>', true);
    // FIX 3a/3b：注入脚本必须用 isLeaf/children.length 守住，跳过有子元素的容器
    expect(out).toContain('children.length===0');
    expect(out).toContain('isLeaf');
  });
});

describe('parseProtoTextEditMessage', () => {
  const valid = {
    source: PROTO_SELECT_SOURCE,
    type: PROTO_TEXT_EDIT_MESSAGE,
    payload: { selector: '#title', newText: '新标题' },
  };

  it('合法消息解析出载荷', () => {
    expect(parseProtoTextEditMessage(valid)).toEqual({ selector: '#title', newText: '新标题' });
  });

  it('允许空 newText（清空文案）', () => {
    expect(parseProtoTextEditMessage({ ...valid, payload: { selector: '#t', newText: '' } })).toEqual({
      selector: '#t',
      newText: '',
    });
  });

  it('来源/类型不符、缺字段或空 selector 返回 null', () => {
    expect(parseProtoTextEditMessage(null)).toBeNull();
    expect(parseProtoTextEditMessage({ ...valid, source: 'evil' })).toBeNull();
    expect(parseProtoTextEditMessage({ ...valid, type: PROTO_SELECT_MESSAGE })).toBeNull();
    expect(parseProtoTextEditMessage({ ...valid, payload: { selector: '#t' } })).toBeNull();
    expect(parseProtoTextEditMessage({ ...valid, payload: { newText: 'x' } })).toBeNull();
    expect(parseProtoTextEditMessage({ ...valid, payload: { selector: '  ', newText: 'x' } })).toBeNull();
  });

  it('不把圈选消息误认成就地编辑消息（类型隔离）', () => {
    const selMsg = {
      source: PROTO_SELECT_SOURCE,
      type: PROTO_SELECT_MESSAGE,
      payload: { tag: 'h1', text: 'x', selector: '#t' },
    };
    expect(parseProtoTextEditMessage(selMsg)).toBeNull();
  });
});
