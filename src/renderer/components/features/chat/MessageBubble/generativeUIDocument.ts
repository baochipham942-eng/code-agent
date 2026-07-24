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

const INJECTED_STYLES = `<style>
body {
  margin: 0; padding: 16px;
  background: #18181b; color: #e4e4e7;
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

/**
 * 剥掉所有 <script>。用 DOMParser 而不是正则——正则挡不住 `<script >`、
 * 属性里带 `</script` 的字符串这类写法，而模型什么都写得出来。
 */
export function stripScripts(code: string): string {
  const isFullDocument = /<html/i.test(code);
  const doc = new DOMParser().parseFromString(
    isFullDocument ? code : `<!DOCTYPE html><html><head></head><body>${code}</body></html>`,
    'text/html',
  );
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    script.remove();
  }
  return isFullDocument ? doc.documentElement.outerHTML : doc.body.innerHTML;
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
