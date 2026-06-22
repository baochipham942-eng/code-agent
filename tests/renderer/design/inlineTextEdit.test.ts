// 原型就地文本编辑回写纯函数（CD-Parity §3）单测。
// applyTextEdit 在 canonical HTML 上按 selector 定位元素、替换其文本、HTML 转义防注入、
// 序列化回字符串。selector 语义与 designPreviewInject 的 path() 一致（#id / tag.class /
// tag:nth-child(n)，以 ` > ` 连接，最多 6 层）。纯函数、零 DOM 依赖，node 环境可跑。
import { describe, expect, it } from 'vitest';
import { applyTextEdit } from '../../../src/renderer/components/design/inlineTextEdit';

describe('applyTextEdit', () => {
  it('按 id selector 替换叶子文本', () => {
    const html = '<html><body><h1 id="title">老标题</h1></body></html>';
    const out = applyTextEdit(html, '#title', '新标题');
    expect(out).toContain('<h1 id="title">新标题</h1>');
    expect(out).not.toContain('老标题');
  });

  it('按 tag.class selector 替换文本', () => {
    const html = '<body><p class="lead intro">hello</p></body>';
    const out = applyTextEdit(html, 'p.lead.intro', 'world');
    expect(out).toContain('>world<');
    expect(out).not.toContain('hello');
  });

  it('按 nth-child selector 命中正确兄弟', () => {
    const html =
      '<body><ul><li>一</li><li>二</li><li>三</li></ul></body>';
    // path() 对无 class 的元素用 1-based nth-child；ul 自身走 body > ul（nth-child(1)）。
    const out = applyTextEdit(html, 'ul:nth-child(1) > li:nth-child(2)', '改了');
    expect(out).toContain('<li>一</li>');
    expect(out).toContain('<li>改了</li>');
    expect(out).toContain('<li>三</li>');
    expect(out).not.toContain('<li>二</li>');
  });

  it('HTML 转义 newText 防注入（<script> → 实体）', () => {
    const html = '<body><h1 id="t">x</h1></body>';
    const out = applyTextEdit(html, '#t', '<script>alert(1)</script>');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;/script&gt;');
  });

  it('转义 & 和引号等实体字符', () => {
    const html = '<body><span id="s">x</span></body>';
    const out = applyTextEdit(html, '#s', 'A & B "C" <D>');
    expect(out).toContain('A &amp; B');
    expect(out).toContain('&lt;D&gt;');
    expect(out).not.toContain('<D>');
  });

  it('selector 未命中：原样返回，不落盘改动', () => {
    const html = '<body><h1 id="title">x</h1></body>';
    const out = applyTextEdit(html, '#nope', 'y');
    expect(out).toBe(html);
  });

  it('保留兄弟节点不变', () => {
    const html =
      '<body><h1 id="a">A</h1><h2 id="b">B</h2><p id="c">C</p></body>';
    const out = applyTextEdit(html, '#b', 'BB');
    expect(out).toContain('<h1 id="a">A</h1>');
    expect(out).toContain('<h2 id="b">BB</h2>');
    expect(out).toContain('<p id="c">C</p>');
  });

  it('保留目标元素的属性', () => {
    const html = '<body><a id="lnk" href="/x" class="btn">go</a></body>';
    const out = applyTextEdit(html, '#lnk', 'gone');
    expect(out).toContain('href="/x"');
    expect(out).toContain('class="btn"');
    expect(out).toContain('>gone</a>');
  });

  it('空 / 非法 selector：原样返回', () => {
    const html = '<body><h1>x</h1></body>';
    expect(applyTextEdit(html, '', 'y')).toBe(html);
    expect(applyTextEdit(html, '   ', 'y')).toBe(html);
  });

  it('替换含简单子元素的元素时只改直接文本，保留子元素结构', () => {
    // 叶子文本场景之外：元素含一个子 <span>。我们只替换直接文本节点，子元素结构保留。
    const html = '<body><h1 id="t">前缀 <span class="hl">高亮</span> 后缀</h1></body>';
    const out = applyTextEdit(html, '#t', '改');
    // 子元素 span 仍在
    expect(out).toContain('<span class="hl">高亮</span>');
    // 直接文本被新文本替换（前后缀的裸文本不再原样保留）
    expect(out).not.toContain('前缀');
    expect(out).not.toContain('后缀');
    expect(out).toContain('改');
  });
});
