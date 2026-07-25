// 预览样式注入。设计原型是 `srcDoc` 沙箱单文件 HTML，这里只做一件事：把滚动条美化
// 样式插进 <head>。
//
// 历史：本文件原先还承载「圈选 / 就地文本编辑」的 `neo-design:*` postMessage 协议
// （injectSelectionScript / injectInlineEditScript / parseProto*Message / PROTO_PALETTES 等）。
// 那套的唯一宿主是全屏设计表单 `DesignWorkspace.tsx`，已随 #621「退役全屏设计表单」删除，
// 而 S5 的 HTML 可视化编辑（#642）走的是另一条路——htmlLocality + applyHtmlElementEdit
// 补丁引擎，不经过本文件。两条 surface 各自演进，旧协议在宿主退役后成了纯残件，
// 于 2026-07-25 随孤儿能力审计一并清除（同批删掉 inlineTextEdit.ts / protoSpine.ts）。

const PREVIEW_STYLE = `<style data-neo-design-style>
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:rgba(140,140,150,.35);border-radius:8px}
*::-webkit-scrollbar-thumb:hover{background:rgba(140,140,150,.55)}
html{scrollbar-width:thin;scrollbar-color:rgba(140,140,150,.35) transparent}
</style>`;

/**
 * 给预览 HTML 注入滚动条美化样式（插在 <head> 起始处，原型自带样式可覆盖）。
 * 无 <head> 时补一个；都没有则前置。
 */
export function injectPreviewStyle(html: string): string {
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + PREVIEW_STYLE + html.slice(at);
  }
  const htmlOpen = /<html[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${PREVIEW_STYLE}</head>${html.slice(at)}`;
  }
  return PREVIEW_STYLE + html;
}
