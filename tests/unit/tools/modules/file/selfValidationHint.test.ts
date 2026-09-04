// 2026-09-04 N-SELFVALIDATE-NUDGE：validate_html_in_app 可达之后，真跑实测模型仍 0 次去验
// （写完 HTML 就交差）。提示放在「刚写完那一刻」的工具返回值里，而不是每轮开头的工具清单里。
import { describe, expect, it } from 'vitest';
import {
  buildSelfValidationHint,
  countInteractiveHtmlElements,
} from '../../../../../src/host/tools/modules/file/write';

describe('countInteractiveHtmlElements', () => {
  it('数按钮/输入/下拉/文本域/带 href 的链接/内联事件/监听器', () => {
    const html = `<button id="go">Go</button><input type="text"><select><option>a</option></select>
      <textarea></textarea><a href="#x">x</a><div onclick="run()"></div>
      <script>document.querySelector('#go').addEventListener('click', run)</script>`;
    expect(countInteractiveHtmlElements(html)).toBe(7);
  });

  it('纯展示页面数出 0——锚点没有 href 不算交互', () => {
    expect(countInteractiveHtmlElements('<h1>标题</h1><p>正文</p><a>不可点</a><img src="x.png">')).toBe(0);
  });
});

describe('buildSelfValidationHint', () => {
  it('写出有交互元素的 HTML 时给出提示，并带上具体路径与元素数', () => {
    const hint = buildSelfValidationHint('/tmp/demo/test-ui.html', '<button>发送</button><input>');

    expect(hint).toContain('2 interactive element(s)');
    expect(hint).toContain('select:validate_html_in_app');
    expect(hint).toContain('htmlPath="/tmp/demo/test-ui.html"');
  });

  it('.htm 同等对待', () => {
    expect(buildSelfValidationHint('/tmp/a.htm', '<button>x</button>')).not.toBe('');
  });

  // 滥用由时机本身挡掉：不是 HTML、或页面没有可交互元素，都不出提示。
  it('改样式表不出提示', () => {
    expect(buildSelfValidationHint('/tmp/site.css', 'button { color: red }')).toBe('');
  });

  it('写普通代码不出提示', () => {
    expect(buildSelfValidationHint('/tmp/app.ts', 'const button = 1; addEventListener("x", y);')).toBe('');
  });

  it('纯展示的 HTML 不出提示', () => {
    expect(buildSelfValidationHint('/tmp/readme.html', '<h1>Hello</h1><p>没有可点的东西</p>')).toBe('');
  });
});
