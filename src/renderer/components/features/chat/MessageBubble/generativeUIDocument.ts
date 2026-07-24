// ============================================================================
// Generative UI 文档构建 — 预览态与编辑态两套 srcdoc，权限互斥
// ============================================================================
//
// 编辑态要读 iframe.contentDocument 取点选元素，就必须给 allow-same-origin；
// srcdoc iframe 拿到同源后再叠 allow-scripts，模型写的脚本就能 window.parent
// 摸到整个应用。所以两种权限永不同时给：
//
//   预览态 = allow-scripts（跨源），脚本照跑，动效正常
//   编辑态 = allow-same-origin（无脚本权限），且源码里的 <script> 先剥掉
//
// 剥脚本是第二道线：sandbox 少了 allow-scripts 本就一个字节都执行不了，
// 剥掉是为了「编辑态没有脚本可跑」这个安全前提不依赖某个属性写对。

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:;">`;

/** 沙箱页面的正文色。属性面板读不出颜色时拿它兜底，两处必须是同一个值。 */
export const SANDBOX_TEXT_COLOR = '#e4e4e7'; // ds-allow:viz 沙箱 iframe 内文档的内容色，非本应用 UI 样式，无对应 token

const INJECTED_STYLES = `<style>
body {
  margin: 0; padding: 16px;
  background: #18181b; color: ${SANDBOX_TEXT_COLOR};
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(113, 113, 122, 0.4); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(113, 113, 122, 0.6); }
</style>`;

const HEIGHT_REPORTER_SCRIPT = `<script>
(function() {
  function reportHeight() {
    var h = document.body.scrollHeight;
    window.parent.postMessage({ type: 'generative-ui-resize', height: h }, '*');
  }
  // Report on load, resize, mutation
  window.addEventListener('load', reportHeight);
  window.addEventListener('resize', reportHeight);
  var observer = new MutationObserver(reportHeight);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  // Initial reports with delay for rendering
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 200);
  setTimeout(reportHeight, 500);
})();
</script>`;

/** 预览态：脚本跑得起来，但不同源，够不着宿主。 */
export const PREVIEW_SANDBOX = 'allow-scripts';
/** 编辑态：同源可点选，但没有 allow-scripts，且 <script> 已剥离。 */
export const EDIT_SANDBOX = 'allow-same-origin';

function wrap(code: string, head: string, bodyTail: string): string {
  // 已是整页文档：注入进它自己的 head / body 末尾
  if (/<html/i.test(code)) {
    const withHead = code.replace(/<head([^>]*)>/i, `<head$1>${head}`);
    return bodyTail ? withHead.replace(/<\/body>/i, `${bodyTail}</body>`) : withHead;
  }
  // 片段：包一层
  return `<!DOCTYPE html><html><head>${head}</head><body>${code}${bodyTail}</body></html>`;
}

/** 源码文档：不带任何注入，就是补丁要打上去的那一份。 */
function parseSource(code: string): { doc: Document; isFullDocument: boolean } {
  const isFullDocument = /<html/i.test(code);
  const doc = new DOMParser().parseFromString(
    isFullDocument ? code : `<!DOCTYPE html><html><head></head><body>${code}</body></html>`,
    'text/html',
  );
  return { doc, isFullDocument };
}

function serializeSource(doc: Document, isFullDocument: boolean): string {
  if (!isFullDocument) return doc.body.innerHTML;
  // documentElement.outerHTML 不含 doctype，原文有就补回去
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '';
  return `${doctype}${doc.documentElement.outerHTML}`;
}

/**
 * 剥掉所有 <script>。用 DOMParser 而不是正则——正则挡不住 `<script >`、
 * 属性里带 `</script` 的字符串这类写法，而模型什么都写得出来。
 */
export function stripScripts(code: string): string {
  const { doc, isFullDocument } = parseSource(code);
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    script.remove();
  }
  return serializeSource(doc, isFullDocument);
}

/** 飞书演示的三项，一项都不多。 */
export interface HtmlElementEdit {
  selector: string;
  text?: string;
  /** px */
  fontSize?: number;
  /** #rrggbb */
  color?: string;
}

type HtmlEditFailure =
  | 'selector_missed'
  | 'text_target_has_children';

export type HtmlEditResult =
  | { ok: true; code: string }
  | { ok: false; reason: HtmlEditFailure };

/** 只含文本的元素才允许改文字；有子元素时改 textContent 会把整棵子树抹掉。 */
export function isTextEditable(element: Element): boolean {
  return element.children.length === 0;
}

/**
 * 把一次元素级修改打进源码。
 *
 * 刻意不做 DOM 序列化回写整页——`buildPreviewSrcdoc` 往文档里塞了 CSP / 样式 /
 * 高度上报脚本，序列化渲染态会把这些烙进模型的源码里。这里只在**源码文档**上
 * 改目标元素的文本或内联 style，其余节点一个不碰。
 *
 * fail-closed：选择器命不中就报 selector_missed，不静默改错元素——那是用户
 * （非程序员）永远发现不了的一类错。
 */
export function applyHtmlElementEdit(code: string, edit: HtmlElementEdit): HtmlEditResult {
  const { doc, isFullDocument } = parseSource(code);
  // DOMParser 造出来的文档没有浏览上下文，defaultView 是 null，
  // 所以不能用 `instanceof doc.defaultView.HTMLElement` 判类型。
  const target = doc.querySelector(edit.selector) as HTMLElement | null;
  if (!target?.style) return { ok: false, reason: 'selector_missed' };

  if (edit.text !== undefined) {
    if (!isTextEditable(target)) return { ok: false, reason: 'text_target_has_children' };
    target.textContent = edit.text;
  }
  if (edit.fontSize !== undefined) {
    target.style.fontSize = `${edit.fontSize}px`;
  }
  if (edit.color !== undefined) {
    target.style.color = edit.color;
  }

  return { ok: true, code: serializeSource(doc, isFullDocument) };
}

export function buildPreviewSrcdoc(code: string): string {
  return wrap(code, `${CSP_META}${INJECTED_STYLES}`, HEIGHT_REPORTER_SCRIPT);
}

/**
 * 编辑态 srcdoc。高度上报脚本一并去掉（没有 allow-scripts 它跑不了，
 * 而且编辑态同源，父窗口直接读 body.scrollHeight 更准）。
 * CSP 保留：没有它，页面里的远程 <img> 会在编辑态真发请求。
 */
export function buildEditSrcdoc(code: string): string {
  return wrap(stripScripts(code), `${CSP_META}${INJECTED_STYLES}`, '');
}

/**
 * 导出成一个双击就能看、能发给同事的独立 .html 文件。
 * 相比预览 srcdoc 减两样：CSP meta（脱离 iframe 只剩噪音）、高度上报脚本
 * （window.parent 在独立页面里没有意义）。INJECTED_STYLES 必须留——prompt 让模型
 * 按暗色主题配色，不带样式导出就是白底浅字一片糊。模型自己的 <script> 保留，
 * 导出的是真页面，动效该照跑。用户手工编辑的 <!-- neo:user-edited --> 注释随内容带出去。
 */
export function buildStandaloneHtml(code: string): string {
  return wrap(code, INJECTED_STYLES, '');
}

/** 取产物的 <title> 作导出文件名；没有就返回 null，让调用方兜底。 */
export function extractHtmlTitle(code: string): string | null {
  const match = code.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.trim();
  return title ? title : null;
}
