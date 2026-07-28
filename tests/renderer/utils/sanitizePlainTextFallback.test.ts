import { describe, expect, it } from 'vitest';
import { sanitizePlainTextFallback, stripRawHtmlOutsideCode } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

// QA 2026-07-28 A3：流式纯文本通道 / MarkdownCore 懒加载 fallback 没有解析能力，
// 模型输出的原始 HTML 标签和 IACT 链接语法会被原样露出。兜底通道统一降级清洗。
describe('sanitizePlainTextFallback — 纯文本兜底降级', () => {
  it('剥掉 HTML 标签只留内部文本', () => {
    expect(sanitizePlainTextFallback('<span style="color:red">❌执行失败</span>')).toBe('❌执行失败');
  });

  it('IACT 链接降级为链接文字，不露出协议', () => {
    expect(sanitizePlainTextFallback('可以[重新描述你想做的操作](!add)试试')).toBe('可以重新描述你想做的操作试试');
  });

  it('多个 IACT 协议（!send/!run/!open 等）都降级', () => {
    expect(sanitizePlainTextFallback('[发我](!send) 和 [ls -la](!run)')).toBe('发我 和 ls -la');
  });

  it('普通文本里的比较符号不误伤（< 后不是字母）', () => {
    expect(sanitizePlainTextFallback('a < b 且 c > d')).toBe('a < b 且 c > d');
  });

  it('普通 markdown 链接语法保持原样（纯文本通道本来就这么显示）', () => {
    expect(sanitizePlainTextFallback('[官网](https://example.com)')).toBe('[官网](https://example.com)');
  });
});

// A3 现象1 的完成态版本：上游把 HTML 标签转义成字面文本持久化后，react-markdown
// 只能原样展示。渲染前把代码之外的已知 HTML 标签剥掉。
describe('stripRawHtmlOutsideCode — 完成态消息剥离 HTML 标签', () => {
  it('剥掉散文里的 HTML 标签', () => {
    expect(stripRawHtmlOutsideCode('notexist.xyz — <span style="color:red">❌ 执行失败</span>')).toBe('notexist.xyz — ❌ 执行失败');
  });

  it('fenced code block 内的 HTML 原样保留', () => {
    const input = '说明\n```html\n<span>keep me</span>\n```\n<div>strip</div>';
    expect(stripRawHtmlOutsideCode(input)).toBe('说明\n```html\n<span>keep me</span>\n```\nstrip');
  });

  it('inline code 内的标签原样保留', () => {
    expect(stripRawHtmlOutsideCode('用 `<span>` 标签就行')).toBe('用 `<span>` 标签就行');
  });

  it('技术文本的泛型尖括号不误伤（不在标签名单内）', () => {
    expect(stripRawHtmlOutsideCode('类型是 Array<string> 或 Map<string, number>')).toBe('类型是 Array<string> 或 Map<string, number>');
  });

  it('流式截断的未闭合 code fence 之后的内容都按代码保护', () => {
    expect(stripRawHtmlOutsideCode('前文<div>x</div>\n```html\n<span>keep</span>')).toBe('前文x\n```html\n<span>keep</span>');
  });
});
