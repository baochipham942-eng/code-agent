// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEditSrcdoc,
  buildPreviewSrcdoc,
  stripScripts,
  EDIT_SANDBOX,
  PREVIEW_SANDBOX,
} from '../../../src/renderer/components/features/chat/MessageBubble/generativeUIDocument';
import { buildUniqueCssSelector } from '../../../src/renderer/utils/htmlLocality';

const COMPONENT_PATH = path.join(
  __dirname,
  '../../../src/renderer/components/features/chat/MessageBubble/GenerativeUIBlock.tsx',
);

/** 一份贴近模型真实产出的整页 HTML：有 head/style/script、同标签兄弟、嵌套表格。 */
const FULL_DOCUMENT = `<!DOCTYPE html>
<html>
<head>
  <style>.card { padding: 8px }</style>
  <script>window.__boot = 1;</script>
</head>
<body>
  <h1 id="title">季度复盘</h1>
  <section class="card">
    <p>第一段</p>
    <p>第二段</p>
    <table><tbody>
      <tr><td>华东</td><td>12000</td></tr>
      <tr><td>华北</td><td>8500</td></tr>
    </tbody></table>
  </section>
  <section class="card">
    <p>第三段</p>
    <button>导出</button>
    <button>关闭</button>
  </section>
  <script>document.querySelector('button').onclick = function () {};</script>
</body>
</html>`;

/** 片段形态：模型也经常直接给一段 body 内容，不带 <html>。 */
const FRAGMENT = `<div class="wrap">
  <h2>标题</h2>
  <span>甲</span><span>乙</span><span>丙</span>
  <script>console.log('frag');</script>
</div>`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 源码文档 = 不带任何注入，就是 P2 补丁要打上去的那一份。 */
function parseSource(code: string): Document {
  return parse(/<html/i.test(code)
    ? code
    : `<!DOCTYPE html><html><head></head><body>${code}</body></html>`);
}

/**
 * 元素身份：跨文档比对不能比对象引用，用 tag + 属性 + 压平文本对账。
 * 文本要先摘掉 script/style —— 编辑态本来就剥了脚本，含脚本的祖先元素
 * 两边 textContent 必然不同，那是预期的，不是选错了元素。
 */
function identity(element: Element): string {
  const attrs = Array.from(element.attributes)
    .map((attr) => `${attr.name}=${attr.value}`)
    .sort()
    .join('|');
  const clone = element.cloneNode(true) as Element;
  for (const inert of Array.from(clone.querySelectorAll('script, style'))) inert.remove();
  const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  return `${element.tagName.toLowerCase()}#${attrs}#${text}`;
}

describe('编辑态 srcdoc 剥脚本', () => {
  it('整页与片段两种形态的 <script> 都被剥掉，预览态则原样保留', () => {
    for (const code of [FULL_DOCUMENT, FRAGMENT]) {
      expect(parse(buildEditSrcdoc(code)).querySelectorAll('script')).toHaveLength(0);
      // 预览态靠 sandbox 隔离，脚本必须还在（含我们注入的高度上报）
      expect(parse(buildPreviewSrcdoc(code)).querySelectorAll('script').length).toBeGreaterThan(0);
    }
  });

  it('剥脚本不靠正则：奇形怪状的 script 写法一样剥得掉', () => {
    const nasty = `<div>keep</div>
      <script >var a = "</scr" + "ipt>";</script>
      <SCRIPT type="text/javascript">var b = 2;</SCRIPT>
      <script
        defer>var c = 3;</script>`;
    const stripped = stripScripts(nasty);
    expect(parse(`<body>${stripped}</body>`).querySelectorAll('script')).toHaveLength(0);
    expect(stripped).toContain('keep');
  });

  it('编辑态保留 CSP 与暗色样式：没有它们会真发远程请求、且白底浅字看不清', () => {
    const edit = buildEditSrcdoc(FULL_DOCUMENT);
    expect(edit).toContain('Content-Security-Policy');
    expect(edit).toContain('#18181b');
  });
});

describe('选择器跨 document 一致性（编辑文档 ↔ 源码文档）', () => {
  // 这是 P2 回写正确性的承重假设：selector 在带注入的编辑文档里算出来，
  // 却要打在不带注入的源码文档上。错了是静默改错元素，用户发现不了。
  it.each([
    // 16 = h1 + section×2 + p×3 + table + tbody + tr×2 + td×4 + button×2
    ['整页文档', FULL_DOCUMENT, 16],
    ['片段', FRAGMENT, 5],
  ])('%s：每个可选元素在两个文档里解析到同一个元素', (_label, code, expectedCandidates) => {
    const editDoc = parse(buildEditSrcdoc(code));
    const sourceDoc = parseSource(code);

    // script 不可选中（编辑态已剥掉），style/meta 也不是用户点得到的东西
    const candidates = Array.from(editDoc.body.querySelectorAll('*'))
      .filter((element) => !['script', 'style'].includes(element.tagName.toLowerCase()));
    // 钉死条数：候选集悄悄缩水（比如以后误过滤掉一类标签）会让这门变成空转
    expect(candidates).toHaveLength(expectedCandidates);

    for (const element of candidates) {
      const selector = buildUniqueCssSelector(element);
      const resolved = sourceDoc.querySelector(selector);
      expect(resolved, `源码文档里解析不到 ${selector}`).not.toBeNull();
      expect(identity(resolved!), `${selector} 在两个文档里指向了不同元素`)
        .toBe(identity(element));
    }
  });
});

describe('sandbox 两态互斥', () => {
  it('编辑态永不带 allow-scripts，预览态永不带 allow-same-origin', () => {
    expect(EDIT_SANDBOX).not.toContain('allow-scripts');
    expect(EDIT_SANDBOX).toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX).toContain('allow-scripts');
  });

  it('组件只用这两个常量，不许再出现字面量 sandbox（否则常量约束形同虚设）', () => {
    const source = readFileSync(COMPONENT_PATH, 'utf8');
    // 锚点先自检：常量用法找不到说明组件被改写了，此时必须报红而不是静默通过
    expect(source).toContain('sandbox={EDIT_SANDBOX}');
    expect(source).toContain('sandbox={PREVIEW_SANDBOX}');
    expect(source).not.toMatch(/sandbox\s*=\s*["']/);
  });
});
