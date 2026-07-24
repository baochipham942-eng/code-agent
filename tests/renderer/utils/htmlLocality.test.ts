// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  attachHtmlLocalitySelection,
  buildUniqueCssSelector,
  describeHtmlElement,
  htmlLocalityLocationLabel,
} from '../../../src/renderer/utils/htmlLocality';

function clickInDocument(element: Element): void {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error('test document has no window');
  element.dispatchEvent(new view.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  }));
}

describe('HTML locality selector', () => {
  it('嵌套且同标签重复时，生成的 selector 能唯一命中原元素', () => {
    document.body.innerHTML = `
      <main>
        <section>
          <div class="card"><button>第一项</button><button>第二项</button></div>
        </section>
        <section>
          <div class="card"><button>第三项</button><button>目标按钮</button></div>
        </section>
      </main>
    `;
    const target = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent === '目标按钮');
    expect(target).toBeDefined();

    const selector = buildUniqueCssSelector(target!);
    expect(document.querySelector(selector)).toBe(target);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });

  it('提取小写 tag，并把可见文案压平和截断', () => {
    const button = document.createElement('button');
    button.textContent = `  开始\n规划  ${'很长的旅程'.repeat(30)}  `;
    document.body.replaceChildren(button);

    const selection = describeHtmlElement(button);
    expect(selection.tag).toBe('button');
    expect(selection.text).toMatch(/^开始 规划/);
    expect(selection.text?.endsWith('…')).toBe(true);
    expect(selection.text!.length).toBe(120);
  });

  it('无 tag 时使用调用方传入的本地化兜底文案', () => {
    expect(htmlLocalityLocationLabel({
      kind: 'html',
      filePath: '/tmp/prototype.html',
      selector: 'body',
    }, 'HTML element')).toBe('HTML element');
  });
});

describe('HTML locality document lifecycle', () => {
  it('destroy 后移除高亮、监听，并释放旧选中节点引用', () => {
    document.body.innerHTML = '<main><button>开始规划行程</button></main>';
    const button = document.querySelector('button')!;
    const onSelectionChange = vi.fn();
    const controller = attachHtmlLocalitySelection(document, onSelectionChange);

    clickInDocument(button);
    expect(controller.getSelectedElement()).toBe(button);
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(true);
    // 第二参是活元素本身：所见即所得的修改要直接改它
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tag: 'button', text: '开始规划行程' }),
      button,
    );

    controller.destroy();
    expect(controller.getSelectedElement()).toBeNull();
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(false);

    onSelectionChange.mockClear();
    clickInDocument(button);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
