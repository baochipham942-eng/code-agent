// 预览圈选注入（backlog #2）。设计原型是 `srcDoc` 沙箱单文件 HTML，没有 dev-server
// bridge（livePreviewSelection 那套依赖 vite 插件注入 source location，这里用不上）。
// 改用更轻的做法：开启圈选模式时，往 srcDoc 末尾注入一段脚本——拦截点击、就地高亮、
// 计算元素的 CSS 选择器/标签/文案，postMessage 上报父窗口。父侧据此把目标元素带进续编。
//
// 安全：sandbox="allow-scripts" 的 srcDoc 是 opaque origin（event.origin==='null'），
// 父侧无法读 iframe DOM，只能收消息。父侧按 (source 标记 + type + 来自本 iframe
// contentWindow) 校验消息，不信任 origin。注入脚本只在「圈选模式」开时附加，关掉即纯净渲染。

/** 注入脚本 → 父窗口的消息标记与类型。 */
export const PROTO_SELECT_SOURCE = 'neo-design-proto';
export const PROTO_SELECT_MESSAGE = 'neo-design:select';

/** 父侧收到的圈选载荷。 */
export type ProtoSelectPayload = {
  tag: string;
  text: string;
  selector: string;
};

// 注入脚本（IIFE，纯浏览器端运行；不可单测，逻辑尽量自洽）。
const SELECTION_SCRIPT = `<script data-neo-design-select>(function(){
  if (window.__neoDesignSelect) return; window.__neoDesignSelect = true;
  var S=${JSON.stringify(PROTO_SELECT_SOURCE)}, T=${JSON.stringify(PROTO_SELECT_MESSAGE)};
  var st=document.createElement('style');
  st.textContent='*{cursor:crosshair!important}.__neo-hover{outline:2px solid #d946ef!important;outline-offset:1px!important}';
  document.head.appendChild(st);
  function esc(s){try{return (window.CSS&&CSS.escape)?CSS.escape(s):s.replace(/[^a-zA-Z0-9_-]/g,'_');}catch(e){return s;}}
  function path(el){
    if(el.id) return '#'+esc(el.id);
    var parts=[];
    while(el&&el.nodeType===1&&el.tagName.toLowerCase()!=='body'){
      var sel=el.tagName.toLowerCase();
      if(el.classList&&el.classList.length){
        sel+='.'+Array.prototype.slice.call(el.classList,0,2).map(esc).join('.');
      }else if(el.parentNode){
        var i=Array.prototype.indexOf.call(el.parentNode.children,el)+1;
        sel+=':nth-child('+i+')';
      }
      parts.unshift(sel);
      el=el.parentElement;
      if(parts.length>=6) break;
    }
    return parts.join(' > ');
  }
  var last=null;
  document.addEventListener('mouseover',function(e){
    if(last) last.classList.remove('__neo-hover');
    last=e.target; if(last&&last.classList) last.classList.add('__neo-hover');
  },true);
  document.addEventListener('click',function(e){
    e.preventDefault(); e.stopPropagation();
    var el=e.target; if(!el||el.nodeType!==1) return;
    var text=(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60);
    parent.postMessage({source:S,type:T,payload:{tag:el.tagName.toLowerCase(),text:text,selector:path(el)}},'*');
  },true);
})();</script>`;

// 预览滚动条美化样式：把 iframe 文档默认的粗亮原生滚动条换成细、半透明、随主题
// 的样式。刻意插在 <head> 最前面（而非末尾），这样原型若自带滚动条样式仍能覆盖我们的
// 默认值；track 透明让其透出页面背景，不再露出 iframe 的白底。仅作用于预览渲染，不写进
// 导出文件（导出用的是 previewHtml 原文）。
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

/**
 * 圈选模式开时往 HTML 注入圈选脚本（优先插在 </body> 前，否则附到末尾）；关时原样返回。
 */
export function injectSelectionScript(html: string, enabled: boolean): string {
  if (!enabled) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${SELECTION_SCRIPT}</body>`);
  return html + SELECTION_SCRIPT;
}

/** 校验来自 iframe 的消息是否是合法圈选载荷（不信任 origin，只认形状 + 来源标记）。 */
export function parseProtoSelectMessage(data: unknown): ProtoSelectPayload | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.source !== PROTO_SELECT_SOURCE || m.type !== PROTO_SELECT_MESSAGE) return null;
  const p = m.payload as Record<string, unknown> | undefined;
  if (!p || typeof p.selector !== 'string') return null;
  return {
    tag: typeof p.tag === 'string' ? p.tag : '',
    text: typeof p.text === 'string' ? p.text : '',
    selector: p.selector,
  };
}
