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

  // ── leaf-only 加固（adversarial audit HIGH FIX 3a/3b/3c）─────────────────────
  // 旧实现对「含子元素」的目标重建内容区 → 重复后代文本（HIGH-1）/ 对 void 子元素吐畸形
  // 标签（HIGH-2）。新实现限制只编辑叶子文本元素，含子元素一律 no-op。

  it('含 inline 子元素的元素：no-op（不再重建、不重复后代文本）', () => {
    const html = '<body><p id="p">Price: <b>$5</b> only</p></body>';
    const out = applyTextEdit(html, '#p', '改了');
    // 原样返回，不破坏结构、不重复 $5
    expect(out).toBe(html);
  });

  it('含 void 子元素（<br>/<img>）的元素：no-op（不吐畸形标签）', () => {
    const html = '<body><p id="p">line1<br>line2</p></body>';
    const out = applyTextEdit(html, '#p', 'x');
    expect(out).toBe(html);

    const html2 = '<body><figure id="f">caption<img src="/a.png"></figure></body>';
    expect(applyTextEdit(html2, '#f', 'x')).toBe(html2);
  });

  it('叶子文本元素仍可正常替换（含 class 与空白）', () => {
    const html = '<body><h1 class="t" >old</h1></body>';
    const out = applyTextEdit(html, 'h1.t:nth-child(1)', 'new');
    expect(out).toContain('>new<');
    expect(out).not.toContain('old');
  });

  it('同 class 兄弟靠 nth-child 唯一定位：编辑第二个，第一个不动', () => {
    // path() 现在总是带 nth-child；两个 <li class="row"> 用位置区分。
    const html =
      '<body><ul class="list"><li class="row">first</li><li class="row">second</li></ul></body>';
    // ul 是 body 第一个子 → nth-child(1)；第二个 li → nth-child(2)
    const out = applyTextEdit(
      html,
      'ul.list:nth-child(1) > li.row:nth-child(2)',
      'EDITED',
    );
    expect(out).toContain('<li class="row">first</li>');
    expect(out).toContain('<li class="row">EDITED</li>');
    expect(out).not.toContain('>second<');
  });

  // ── tbody 容差（FIX 6）：canonical HTML 写 table>tr 不带 tbody，但 DOM path() 含 tbody 段 ─
  it('locate 容忍自动插入的 tbody 段（table>tr 直定位）', () => {
    const html =
      '<body><table id="tbl"><tr><td>a</td><td>b</td></tr></table></body>';
    // path() 在真实 DOM 会算出 #tbl > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2)
    const out = applyTextEdit(
      html,
      '#tbl > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2)',
      'B2',
    );
    expect(out).toContain('<td>a</td>');
    expect(out).toContain('<td>B2</td>');
    expect(out).not.toContain('<td>b</td>');
  });
});
