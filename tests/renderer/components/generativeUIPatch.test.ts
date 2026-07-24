// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyHtmlElementEdit,
  buildEditSrcdoc,
  isTextEditable,
  SANDBOX_TEXT_COLOR,
} from '../../../src/renderer/components/features/chat/MessageBubble/generativeUIDocument';
import { readElementStyle } from '../../../src/renderer/components/features/chat/MessageBubble/GenerativeUIEditPanel';
import { buildUniqueCssSelector } from '../../../src/renderer/utils/htmlLocality';

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
  </section>
  <section class="card">
    <p>第三段</p>
    <button>导出</button>
    <button>关闭</button>
  </section>
</body>
</html>`;

const FRAGMENT = `<div class="wrap">
  <h2>标题</h2>
  <span>甲</span><span>乙</span><span>丙</span>
</div>`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 全文档逐元素快照：tag + 属性 + 直属文本，用来证明「只有目标那一个变了」。 */
function snapshot(code: string): string[] {
  const doc = parse(/<html/i.test(code) ? code : `<body>${code}</body>`);
  return Array.from(doc.querySelectorAll('*')).map((element) => {
    const attrs = Array.from(element.attributes)
      .map((attr) => `${attr.name}="${attr.value}"`)
      .sort()
      .join(' ');
    const ownText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return `${element.tagName.toLowerCase()}[${attrs}]{${ownText}}`;
  });
}

function diffLines(before: string[], after: string[]): Array<[string, string]> {
  expect(after).toHaveLength(before.length);
  const changed: Array<[string, string]> = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) changed.push([before[index], after[index]]);
  }
  return changed;
}

function patch(code: string, edit: Parameters<typeof applyHtmlElementEdit>[1]): string {
  const result = applyHtmlElementEdit(code, edit);
  if (!result.ok) throw new Error(`patch failed: ${result.reason}`);
  return result.code;
}

describe('补丁纯度：改一处，只有一处变', () => {
  it('改文字：整页文档里只有目标元素的文本变了，注入物零残留', () => {
    const before = snapshot(FULL_DOCUMENT);
    const patched = patch(FULL_DOCUMENT, { selector: '#title', text: 'Q3 复盘' });

    // 渲染态注入的东西绝不能进源码
    expect(patched).not.toContain('Content-Security-Policy');
    expect(patched).not.toContain('#18181b');
    expect(patched).not.toContain('generative-ui-resize');
    expect(patched).not.toContain('data-code-agent-locality');
    // 模型自己写的 script/style 要原样留着
    expect(patched).toContain('window.__boot = 1;');
    expect(patched).toContain('.card { padding: 8px }');

    const changed = diffLines(before, snapshot(patched));
    expect(changed).toHaveLength(1);
    expect(changed[0][0]).toContain('季度复盘');
    expect(changed[0][1]).toContain('Q3 复盘');
  });

  it('改字号与颜色：只在目标元素上多出内联 style，别的元素一个不动', () => {
    const before = snapshot(FULL_DOCUMENT);
    const patched = patch(FULL_DOCUMENT, { selector: '#title', fontSize: 28, color: '#2563eb' });

    const changed = diffLines(before, snapshot(patched));
    expect(changed).toHaveLength(1);
    expect(changed[0][1]).toContain('font-size: 28px');
    expect(changed[0][1]).toContain('color: rgb(37, 99, 235)');
  });

  it('片段形态不会被偷偷包成整页', () => {
    const patched = patch(FRAGMENT, { selector: 'div > span:nth-of-type(2)', text: '乙改' });
    expect(patched).not.toMatch(/<html/i);
    expect(patched).not.toMatch(/<body/i);
    expect(patched).toContain('乙改');

    const changed = diffLines(snapshot(FRAGMENT), snapshot(patched));
    expect(changed).toHaveLength(1);
  });

  it('整页文档保留 doctype，不会掉成裸 <html>', () => {
    const patched = patch(FULL_DOCUMENT, { selector: '#title', fontSize: 20 });
    expect(patched.slice(0, 15).toUpperCase()).toContain('<!DOCTYPE HTML>');
  });

  it('同一次修改打两遍，结果不再变（可反复编辑不churn）', () => {
    const once = patch(FULL_DOCUMENT, { selector: '#title', fontSize: 28, color: '#2563eb' });
    const twice = patch(once, { selector: '#title', fontSize: 28, color: '#2563eb' });
    expect(twice).toBe(once);
  });

  it('连续改多个元素：选择器在改过的源码上依然有效', () => {
    let code = patch(FULL_DOCUMENT, { selector: '#title', text: 'Q3' });
    code = patch(code, { selector: 'body > section:nth-of-type(2) > button:nth-of-type(2)', color: '#ff0000' });
    code = patch(code, { selector: '#title', fontSize: 32 });

    const doc = parse(code);
    expect(doc.querySelector('#title')!.textContent).toBe('Q3');
    expect((doc.querySelector('#title') as HTMLElement).style.fontSize).toBe('32px');
    const secondButton = doc.querySelector('body > section:nth-of-type(2) > button:nth-of-type(2)') as HTMLElement;
    expect(secondButton.textContent).toBe('关闭');
    expect(secondButton.style.color).toBe('rgb(255, 0, 0)');
  });
});

describe('补丁 fail-closed', () => {
  it('选择器命不中就报错，绝不退化成改第一个元素', () => {
    const result = applyHtmlElementEdit(FULL_DOCUMENT, { selector: '#nope', text: 'x' });
    expect(result).toEqual({ ok: false, reason: 'selector_missed' });
  });

  it('目标含子元素时拒绝改文字，不会把子树抹掉', () => {
    const result = applyHtmlElementEdit(FULL_DOCUMENT, {
      selector: 'body > section:nth-of-type(1)',
      text: '整段换掉',
    });
    expect(result).toEqual({ ok: false, reason: 'text_target_has_children' });
    expect(isTextEditable(parse(FULL_DOCUMENT).querySelector('section')!)).toBe(false);
    expect(isTextEditable(parse(FULL_DOCUMENT).querySelector('#title')!)).toBe(true);
  });

  it('含子元素的目标仍可单独改字号颜色（继承生效）', () => {
    const patched = patch(FULL_DOCUMENT, {
      selector: 'body > section:nth-of-type(1)',
      fontSize: 18,
    });
    const changed = diffLines(snapshot(FULL_DOCUMENT), snapshot(patched));
    expect(changed).toHaveLength(1);
    expect(changed[0][1]).toContain('font-size: 18px');
  });
});

describe('编辑态点选出来的选择器，直接拿去打补丁就能命中', () => {
  // P1 那道跨 document 一致性门证明了「解析得到同一个元素」，这里再往前一步：
  // 真的用它改一次，改中的必须是同一个元素。
  it.each([
    ['整页文档', FULL_DOCUMENT],
    ['片段', FRAGMENT],
  ])('%s', (_label, code) => {
    const editDoc = parse(buildEditSrcdoc(code));
    const candidates = Array.from(editDoc.body.querySelectorAll('*'))
      .filter((element) => !['script', 'style'].includes(element.tagName.toLowerCase()))
      .filter((element) => isTextEditable(element) && (element.textContent ?? '').trim().length > 0);
    expect(candidates.length).toBeGreaterThan(2);

    for (const element of candidates) {
      const selector = buildUniqueCssSelector(element);
      const originalText = element.textContent ?? '';
      const patched = patch(code, { selector, text: `${originalText}·改` });
      const patchedDoc = parse(/<html/i.test(patched) ? patched : `<body>${patched}</body>`);
      expect(patchedDoc.querySelector(selector)!.textContent).toBe(`${originalText}·改`);
    }
  });
});

describe('属性面板读当前值', () => {
  it('内联 style 优先于计算样式——用户此前改过的值必须显示出来', () => {
    document.body.innerHTML = '<h1 style="font-size: 28px; color: rgb(37, 99, 235)">标题</h1>';
    expect(readElementStyle(document.querySelector('h1')!)).toEqual({
      fontSize: 28,
      color: '#2563eb',
    });
  });

  it('三位 hex 补齐成六位，取色器才认', () => {
    document.body.innerHTML = '<p style="color: #f00">红</p>';
    expect(readElementStyle(document.querySelector('p')!).color).toBe('#ff0000');
  });

  it('颜色读不出来时退到沙箱正文色，不是黑色', () => {
    document.body.innerHTML = '<p style="color: somethingweird">x</p>';
    expect(readElementStyle(document.querySelector('p')!).color).toBe(SANDBOX_TEXT_COLOR);
  });

  it('字号带小数时取整，读不到时给可用的默认值而不是 0', () => {
    document.body.innerHTML = '<p style="font-size: 15.6px">x</p><span>y</span>';
    expect(readElementStyle(document.querySelector('p')!).fontSize).toBe(16);
    expect(readElementStyle(document.querySelector('span')!).fontSize).toBeGreaterThan(0);
  });
});
