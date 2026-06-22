// 原型就地文本编辑（CD-Parity §3）回写纯函数。
//
// 内联编辑（点字直接改）在预览 iframe 里把文本元素设为 contentEditable，blur 时上报
// {selector, newText}。父侧据此把改动写回 *canonical* `prototype.html`（非被注入加工过的
// srcDoc）。本文件提供这条回写的纯函数 `applyTextEdit`，按 selector 定位元素、替换其直接
// 文本、HTML 转义防注入、序列化回字符串，可单测（命中 / 转义 / 未命中 / 保留兄弟与子结构）。
//
// 为什么不用 DOMParser：renderer 运行时确有浏览器 DOMParser，但 vitest 跑在纯 node 环境
// （无 DOMParser/document，仓库未装 jsdom/happy-dom）。为「纯 + 可单测」且零新依赖，这里用
// 一个最小的 HTML tokenizer 自建轻量元素树，仅覆盖 path() 产出的 selector 语义
// （#id / tag.class.class / tag:nth-child(n)，以 ` > ` 连接，最多 6 层），不追求通用 HTML 解析。

/** selector 单段：标签 + 可选 id / 类 / nth-child。 */
type SelectorPart = {
  tag: string | null; // '*' 视为 null（path() 不产 *，但 #id 段 tag 为 null）
  id: string | null;
  classes: string[];
  nth: number | null;
};

/** 轻量元素节点（仅含定位所需信息 + 在源串中的位置）。 */
type ElNode = {
  tag: string;
  id: string | null;
  classes: string[];
  parent: ElNode | null;
  children: ElNode[];
  // 元素内容区（开标签结束之后、闭标签开始之前）在源串中的 [start, end)。void 元素为 null。
  contentStart: number | null;
  contentEnd: number | null;
};

// HTML void 元素（无闭合标签、无内容），不参与文本回写。
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// 原始文本元素：内容不含子元素（其 `<` 不是标签）。回写时整体替换内容即可。
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** HTML 实体转义（防注入）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 解析单段 selector（与 designPreviewInject path() 的产出对齐）。 */
function parseSelectorPart(raw: string): SelectorPart | null {
  const part = raw.trim();
  if (!part) return null;
  const result: SelectorPart = { tag: null, id: null, classes: [], nth: null };

  // nth-child(n) 后缀
  const nthMatch = /:nth-child\((\d+)\)/.exec(part);
  let core = part;
  if (nthMatch) {
    result.nth = Number(nthMatch[1]);
    core = part.slice(0, nthMatch.index);
  }

  // #id 形式（path() 命中 id 时整段就是 '#id'，无 tag）
  if (core.startsWith('#')) {
    const id = core.slice(1).trim();
    if (!id) return null;
    result.id = id;
    return result;
  }

  // tag(.class)* 形式
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[^.\s]+)*)$/.exec(core);
  if (!m) return null;
  result.tag = m[1] ? m[1].toLowerCase() : null;
  if (m[2]) {
    result.classes = m[2]
      .split('.')
      .map((c) => c.trim())
      .filter(Boolean);
  }
  if (!result.tag && !result.id && result.classes.length === 0 && result.nth == null) {
    return null;
  }
  return result;
}

/** 解析整条 selector（` > ` 连接的 descendant-direct-child 链）。空 / 非法返回 null。 */
function parseSelector(selector: string): SelectorPart[] | null {
  if (!selector?.trim()) return null;
  const segs = selector.split('>').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return null;
  const parts: SelectorPart[] = [];
  for (const seg of segs) {
    const p = parseSelectorPart(seg);
    if (!p) return null;
    parts.push(p);
  }
  return parts;
}

/** 解析标签属性里的 id 与 class（仅取定位所需）。 */
function parseAttrs(attrText: string): { id: string | null; classes: string[] } {
  let id: string | null = null;
  let classes: string[] = [];
  const idM = /\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrText);
  if (idM) id = (idM[2] ?? idM[3] ?? idM[4] ?? '').trim() || null;
  const clsM = /\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrText);
  if (clsM) {
    const v = clsM[2] ?? clsM[3] ?? clsM[4] ?? '';
    classes = v.split(/\s+/).map((c) => c.trim()).filter(Boolean);
  }
  return { id, classes };
}

/**
 * 构建轻量元素树。返回 root 的伪节点（tag='#root'），其 children 为顶层元素。
 * 仅记录元素结构 + 各元素内容区在源串中的偏移，供后续按 selector 定位 + 文本替换。
 */
function buildTree(html: string): ElNode {
  const root: ElNode = {
    tag: '#root', id: null, classes: [], parent: null, children: [],
    contentStart: 0, contentEnd: html.length,
  };
  let current = root;
  // 匹配标签：注释、闭标签、开标签。其余视为文本，跳过。
  const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const full = m[0];
    if (full.startsWith('<!--')) continue; // 注释
    const closeTag = m[1];
    const openTag = m[2];
    if (closeTag) {
      const tag = closeTag.toLowerCase();
      // 找到最近的同名祖先并闭合（容错未配对）。
      let node: ElNode | null = current;
      while (node && node.tag !== tag) node = node.parent;
      if (node?.parent) {
        node.contentEnd = m.index;
        current = node.parent;
      }
      continue;
    }
    if (openTag) {
      const tag = openTag.toLowerCase();
      const attrText = m[3] ?? '';
      const selfClose = m[4] === '/';
      const { id, classes } = parseAttrs(attrText);
      const node: ElNode = {
        tag, id, classes, parent: current, children: [],
        contentStart: m.index + full.length, contentEnd: null,
      };
      current.children.push(node);
      if (selfClose || VOID_TAGS.has(tag)) {
        node.contentEnd = node.contentStart; // 无内容
        continue;
      }
      if (RAW_TEXT_TAGS.has(tag)) {
        // 原始文本元素：直接吃到对应闭标签，不进入其中找子元素。
        const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
        closeRe.lastIndex = tagRe.lastIndex;
        const cm = closeRe.exec(html);
        if (cm) {
          node.contentEnd = cm.index;
          tagRe.lastIndex = cm.index + cm[0].length;
        } else {
          node.contentEnd = html.length;
          tagRe.lastIndex = html.length;
        }
        continue;
      }
      current = node; // 进入该元素
    }
  }
  // 未闭合的元素内容区兜底到末尾。
  const fix = (n: ElNode): void => {
    if (n.contentEnd == null) n.contentEnd = n.contentStart;
    n.children.forEach(fix);
  };
  root.children.forEach(fix);
  return root;
}

/** 该元素在其父的「同名兄弟」里是第几个（1-based）；path() 的 nth-child 实为同标签序号近似。 */
function siblingIndex(node: ElNode): number {
  if (!node.parent) return 1;
  // path() 用 parentNode.children 全体的 1-based index；这里以全体兄弟计数对齐。
  return node.parent.children.indexOf(node) + 1;
}

/** 单个元素是否匹配 selector 段。 */
function matchPart(node: ElNode, part: SelectorPart): boolean {
  if (part.id != null) {
    if (node.id !== part.id) return false;
    // path() 命中 id 时该段无 tag 约束，直接以 id 唯一定位。
    return true;
  }
  if (part.tag && node.tag !== part.tag) return false;
  for (const c of part.classes) {
    if (!node.classes.includes(c)) return false;
  }
  if (part.nth != null && siblingIndex(node) !== part.nth) return false;
  return true;
}

/**
 * 在树里按 selector 链（直接子代关系）定位首个命中元素。
 * 第一段从任意深度起匹配（descendant），其后各段为直接子代。返回 null 表示未命中。
 */
function locate(root: ElNode, parts: SelectorPart[]): ElNode | null {
  // 第一段：在整棵树里找首个匹配（深度优先，先序）。
  const firstMatches: ElNode[] = [];
  const collect = (n: ElNode): void => {
    if (n.tag !== '#root' && matchPart(n, parts[0])) firstMatches.push(n);
    n.children.forEach(collect);
  };
  collect(root);

  for (const start of firstMatches) {
    let node: ElNode = start;
    let ok = true;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      // 下一段：在 node 的直接子代里找首个匹配。
      const child: ElNode | undefined = node.children.find((c) => matchPart(c, part));
      // tbody 容差：浏览器对 <table> 自动插入 <tbody>，path() 算 selector 时 DOM 里有
      // tbody 段，但 canonical HTML 常写成 table>tr 不带 tbody。若该段是 tbody 且当前
      // node 是 table 下找不到 tbody，则把这段视作穿透——下一段继续在 table 的子代里找。
      if (!child && part.tag === 'tbody' && node.tag === 'table' &&
          !node.children.some((c) => c.tag === 'tbody')) {
        continue; // 跳过 tbody 段，node 不下沉，让后续段直接匹配 table 的 tr 子代
      }
      if (!child) {
        ok = false;
        break;
      }
      node = child;
    }
    if (ok) return node;
  }
  return null;
}

/**
 * 把 canonical HTML 里 selector 命中的*叶子文本元素*的内容替换为（转义后的）newText，
 * 保留其属性；selector 未命中 / 非法 / 匹配为空 / 目标含子元素时原样返回 html（no-op）。
 *
 * - 叶子文本元素（无子元素）：内容整体替换为转义文本。
 * - 含子元素的元素：no-op（注入脚本只对叶子开放编辑；重建含子元素的内容区会重复后代文本
 *   或对 void/自闭子元素吐畸形标签，是 corruption 来源，故防御性不改）。
 */
export function applyTextEdit(html: string, selector: string, newText: string): string {
  const parts = parseSelector(selector);
  if (!parts) return html;

  let root: ElNode;
  try {
    root = buildTree(html);
  } catch {
    return html;
  }
  const target = locate(root, parts);
  if (target?.contentStart == null || target.contentEnd == null) return html;

  // 仅处理叶子文本元素：注入脚本已限制只对无子元素的叶子开放编辑，这里防御性地
  // 对「含子元素」的目标返回原 html（no-op）——重建含子元素的内容区会重复后代文本 /
  // 对 void(<br>/<img>) 与自闭 <p> 吐出畸形标签，是 corruption 来源，宁可不改。
  if (target.children.length > 0) {
    return html;
  }
  const escaped = escapeHtml(newText);
  return html.slice(0, target.contentStart) + escaped + html.slice(target.contentEnd);
}
