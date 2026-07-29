// ============================================================================
// composerRichTextModel - contenteditable composer 的纯 DOM 模型层
// ============================================================================
//
// 结构约定（保持扁平，浏览器编辑不产生嵌套块）：
//   root
//   ├─ Text（含 '\n'，靠 CSS white-space: pre-wrap 渲染换行，不用 <br>）
//   ├─ <span data-composer-chip-key contenteditable=false>（chip 挂载点，React portal 填入）
//   └─ Text …
//
// 纯文本坐标系（plain-text offset）：只数文本字符，chip 是零宽原子节点。
// `value` = 全部文本节点拼接（不含 chip 的任何内容），chip 状态在 composerStore /
// attachments 里，DOM 挂载点只是渲染。所有函数不依赖 React，可在 jsdom 直接单测。

export type InlineChipKind = 'command' | 'skill' | 'file';

export interface InlineChipRef {
  /** 唯一键：`${kind}:${id}`，DOM 挂载点与 store 条目的对账依据 */
  key: string;
  kind: InlineChipKind;
  /** command → 命令 id；skill → skillName；file → attachment.id */
  id: string;
}

const COMPOSER_CHIP_KEY_ATTR = 'data-composer-chip-key';
const COMPOSER_CHIP_KIND_ATTR = 'data-composer-chip-kind';
const COMPOSER_CHIP_ID_ATTR = 'data-composer-chip-id';

function isChipMount(node: Node | null | undefined): boolean {
  return Boolean(
    node
    && node.nodeType === 1
    && (node as HTMLElement).hasAttribute
    && (node as HTMLElement).hasAttribute(COMPOSER_CHIP_KEY_ATTR),
  );
}

export function createChipMount(chip: InlineChipRef): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute(COMPOSER_CHIP_KEY_ATTR, chip.key);
  el.setAttribute(COMPOSER_CHIP_KIND_ATTR, chip.kind);
  el.setAttribute(COMPOSER_CHIP_ID_ATTR, chip.id);
  el.contentEditable = 'false';
  // inline-block 让 chip 作为文字流中的原子节点参与折行
  el.className = 'composer-inline-chip-mount inline-block align-baseline';
  return el;
}

export function chipRefFromMount(mount: HTMLElement): InlineChipRef {
  return {
    key: mount.getAttribute(COMPOSER_CHIP_KEY_ATTR) ?? '',
    kind: (mount.getAttribute(COMPOSER_CHIP_KIND_ATTR) ?? 'file') as InlineChipKind,
    id: mount.getAttribute(COMPOSER_CHIP_ID_ATTR) ?? '',
  };
}

export function listChipMounts(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll(`[${COMPOSER_CHIP_KEY_ATTR}]`)) as HTMLElement[];
}

export function findChipMount(root: HTMLElement, key: string): HTMLElement | null {
  return listChipMounts(root).find((mount) => mount.getAttribute(COMPOSER_CHIP_KEY_ATTR) === key) ?? null;
}

/** 子树的纯文本长度（chip 零宽，<br> 记 1，防御浏览器可能产生的嵌套块）。 */
function plainLength(node: Node): number {
  if (node.nodeType === 3) return (node as Text).data.length;
  if (isChipMount(node)) return 0;
  const el = node as HTMLElement;
  if (el.tagName === 'BR') return 1;
  let sum = 0;
  node.childNodes.forEach((child) => { sum += plainLength(child); });
  return sum;
}

/** 提取编辑区纯文本：文本节点拼接，chip 跳过，<br>/块级边界折算 '\n'（防御性）。 */
export function extractComposerPlainText(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out += (node as Text).data;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (isChipMount(el)) return;
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    const isBlock = el.tagName === 'DIV' || el.tagName === 'P';
    if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

/** 当前光标（selection start）的纯文本偏移；选区不在编辑区内时返回 null。 */
export function getCaretPlainTextOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const anchorNode = range.startContainer;
  const anchorOffset = range.startOffset;
  if (!root.contains(anchorNode)) return null;

  let acc = 0;
  const walk = (node: Node): boolean => {
    if (node === anchorNode) {
      if (node.nodeType === 3) {
        acc += anchorOffset;
      } else {
        for (let i = 0; i < anchorOffset; i += 1) {
          acc += plainLength(node.childNodes[i]);
        }
      }
      return true;
    }
    if (node.nodeType === 3) {
      acc += (node as Text).data.length;
      return false;
    }
    if (isChipMount(node)) return false;
    if ((node as HTMLElement).tagName === 'BR') {
      acc += 1;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true;
    }
    return false;
  };
  for (const child of Array.from(root.childNodes)) {
    if (walk(child)) break;
  }
  return acc;
}

function applyCaretPosition(node: Node, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 把光标放到纯文本偏移处；越过末尾则收在编辑区最后。 */
export function setCaretPlainTextOffset(root: HTMLElement, offset: number): void {
  let acc = 0;
  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.nodeType === 3) {
      const len = (child as Text).data.length;
      if (offset <= acc + len) {
        applyCaretPosition(child, offset - acc);
        return;
      }
      acc += len;
      continue;
    }
    if (isChipMount(child)) continue;
    const len = plainLength(child);
    if (offset <= acc) {
      applyCaretPosition(root, i);
      return;
    }
    acc += len;
  }
  applyCaretPosition(root, root.childNodes.length);
}

/** 删除纯文本区间 [start, end)（只动文本与 <br>，chip 零宽不受影响）。 */
export function deletePlainTextRange(root: HTMLElement, start: number, end: number): void {
  if (end <= start) return;
  let acc = 0;
  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) {
        const text = child as Text;
        const len = text.data.length;
        const s = Math.max(start - acc, 0);
        const e = Math.min(end - acc, len);
        if (e > s) {
          const next = text.data.slice(0, s) + text.data.slice(e);
          if (next) text.data = next;
          else text.remove();
        }
        acc += len;
        continue;
      }
      if (isChipMount(child)) continue;
      if ((child as HTMLElement).tagName === 'BR') {
        if (start <= acc && acc < end) (child as HTMLElement).remove();
        acc += 1;
        continue;
      }
      walk(child);
    }
  };
  walk(root);
}

/** 在纯文本偏移处插入 chip 挂载点（文本节点中途插入时自动断开）。 */
export function insertChipAtPlainOffset(root: HTMLElement, offset: number, chip: InlineChipRef): HTMLElement {
  const mount = createChipMount(chip);
  let acc = 0;
  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.nodeType === 3) {
      const len = (child as Text).data.length;
      if (offset <= acc + len) {
        const at = offset - acc;
        if (at <= 0) {
          root.insertBefore(mount, child);
        } else if (at >= len) {
          root.insertBefore(mount, child.nextSibling);
        } else {
          const after = (child as Text).splitText(at);
          root.insertBefore(mount, after);
        }
        return mount;
      }
      acc += len;
      continue;
    }
    if (isChipMount(child)) {
      if (offset <= acc) {
        root.insertBefore(mount, child);
        return mount;
      }
      continue;
    }
    const len = plainLength(child);
    if (offset <= acc) {
      root.insertBefore(mount, child);
      return mount;
    }
    acc += len;
  }
  root.appendChild(mount);
  return mount;
}

/** 触发词替换：删除纯文本区间 [start, end)，在原位插入 chip 挂载点，光标落在 chip 后。 */
export function replaceRangeWithChipMount(root: HTMLElement, start: number, end: number, chip: InlineChipRef): HTMLElement {
  deletePlainTextRange(root, start, end);
  const mount = insertChipAtPlainOffset(root, start, chip);
  setCaretAfterMount(root, mount);
  return mount;
}

function setCaretAfterMount(root: HTMLElement, mount: HTMLElement): void {
  const index = Array.prototype.indexOf.call(root.childNodes, mount);
  applyCaretPosition(root, index + 1);
}

/** 删除 chip 挂载点，光标落在 chip 原位置（删除后继续打字的落点）。 */
export function removeChipMountWithCaret(root: HTMLElement, mount: HTMLElement): void {
  const index = Array.prototype.indexOf.call(root.childNodes, mount);
  mount.remove();
  applyCaretPosition(root, Math.max(index, 0));
}

/** 光标紧贴 chip 之后（Backspace 应删 chip）时返回该挂载点。 */
export function chipMountBeforeCaret(root: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  const offset = range.startOffset;
  if (!root.contains(node)) return null;
  if (node === root) {
    const prev = root.childNodes[offset - 1];
    return isChipMount(prev) ? (prev as HTMLElement) : null;
  }
  if (node.nodeType === 3) {
    if (offset > 0) return null;
    const prev = node.previousSibling;
    return isChipMount(prev) ? (prev as HTMLElement) : null;
  }
  return null;
}

/** 光标紧贴 chip 之前（Delete 应删 chip）时返回该挂载点。 */
export function chipMountAfterCaret(root: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  const offset = range.startOffset;
  if (!root.contains(node)) return null;
  if (node === root) {
    const next = root.childNodes[offset];
    return isChipMount(next) ? (next as HTMLElement) : null;
  }
  if (node.nodeType === 3) {
    if (offset < (node as Text).data.length) return null;
    const next = node.nextSibling;
    return isChipMount(next) ? (next as HTMLElement) : null;
  }
  return null;
}

/** 在当前光标处插入纯文本（可含 '\n'）；无有效选区时追加到末尾。 */
export function insertPlainTextAtCaret(root: HTMLElement, text: string): void {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).startContainer)) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  root.appendChild(document.createTextNode(text));
  setCaretPlainTextOffset(root, extractComposerPlainText(root).length);
}

/** 外部 value 同步：清掉全部非 chip 节点，文本整体放到第一颗 chip 前（chip 保持原位）。 */
export function rebuildComposerText(root: HTMLElement, value: string): void {
  for (const child of Array.from(root.childNodes)) {
    if (!isChipMount(child)) (child as HTMLElement | Text).remove();
  }
  if (!value) return;
  const textNode = document.createTextNode(value);
  root.insertBefore(textNode, root.firstChild);
}

/** store → DOM 对账：移除已不在清单里的挂载点，缺失的补到末尾。 */
export function syncChipMounts(root: HTMLElement, chips: InlineChipRef[]): void {
  const wanted = new Set(chips.map((chip) => chip.key));
  for (const mount of listChipMounts(root)) {
    if (!wanted.has(mount.getAttribute(COMPOSER_CHIP_KEY_ATTR) ?? '')) mount.remove();
  }
  for (const chip of chips) {
    if (!findChipMount(root, chip.key)) root.appendChild(createChipMount(chip));
  }
}
