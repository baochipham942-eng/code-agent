import type { HtmlLocalityAnchor } from '../../shared/livePreview/localityFeedback';

const SELECTED_ATTRIBUTE = 'data-code-agent-locality-selected';
const STYLE_ATTRIBUTE = 'data-code-agent-locality-style';
const MAX_VISIBLE_TEXT_LENGTH = 120;

export interface HtmlElementSelection {
  selector: string;
  tag: string;
  text?: string;
}

export interface HtmlLocalitySelectionController {
  clear: () => void;
  destroy: () => void;
  getSelectedElement: () => Element | null;
}

function escapeCssIdentifier(value: string): string {
  const cssEscape = globalThis.CSS?.escape;
  if (cssEscape) return cssEscape(value);

  return Array.from(value)
    .map((char, index) => {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint === 0) return '\uFFFD';
      if (
        (codePoint >= 1 && codePoint <= 31)
        || codePoint === 127
        || (index === 0 && codePoint >= 48 && codePoint <= 57)
        || (index === 1 && codePoint >= 48 && codePoint <= 57 && value.charAt(0) === '-')
      ) {
        return `\\${codePoint.toString(16)} `;
      }
      if (index === 0 && char === '-' && value.length === 1) return '\\-';
      if (
        codePoint >= 128
        || char === '-'
        || char === '_'
        || (codePoint >= 48 && codePoint <= 57)
        || (codePoint >= 65 && codePoint <= 90)
        || (codePoint >= 97 && codePoint <= 122)
      ) {
        return char;
      }
      return `\\${char}`;
    })
    .join('');
}

function selectorSegment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;

  const sameTagSiblings = Array.from(parent.children).filter(
    (sibling) => sibling.tagName === element.tagName,
  );
  if (sameTagSiblings.length <= 1) return tag;
  return `${tag}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
}

/**
 * Build a deterministic selector rooted in this document. A unique id shortens the
 * path; otherwise nth-of-type disambiguates same-tag siblings all the way to <html>.
 */
export function buildUniqueCssSelector(element: Element): string {
  const doc = element.ownerDocument;
  const segments: string[] = [];
  let current: Element | null = element;

  while (current) {
    if (current.id) {
      const idSelector = `#${escapeCssIdentifier(current.id)}`;
      if (doc.querySelectorAll(idSelector).length === 1) {
        segments.unshift(idSelector);
        break;
      }
    }

    segments.unshift(selectorSegment(current));
    current = current.parentElement;
  }

  const selector = segments.join(' > ');
  if (doc.querySelector(selector) !== element) {
    throw new Error('无法为选中的 HTML 元素生成唯一 CSS 选择器');
  }
  return selector;
}

export function getVisibleElementText(element: Element): string | undefined {
  const renderedText = 'innerText' in element && typeof element.innerText === 'string'
    ? element.innerText
    : element.textContent;
  const normalized = (renderedText ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_VISIBLE_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_VISIBLE_TEXT_LENGTH - 1)}…`;
}

export function describeHtmlElement(element: Element): HtmlElementSelection {
  return {
    selector: buildUniqueCssSelector(element),
    tag: element.tagName.toLowerCase(),
    text: getVisibleElementText(element),
  };
}

export function htmlLocalityLocationLabel(
  anchor: HtmlLocalityAnchor,
  htmlElementFallback: string,
): string {
  const tag = anchor.tag ? `<${anchor.tag}>` : htmlElementFallback;
  return anchor.text ? `${tag} ${anchor.text}` : tag;
}

/**
 * Attach direct same-origin selection handling to one srcdoc document.
 * destroy() releases the old document/element references before a replacement loads.
 */
export function attachHtmlLocalitySelection(
  doc: Document,
  onSelectionChange: (selection: HtmlElementSelection | null) => void,
): HtmlLocalitySelectionController {
  const style = doc.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  style.textContent = `
    html, body, body * {
      cursor: crosshair !important;
    }
    [${SELECTED_ATTRIBUTE}] {
      outline: 3px solid #22d3ee !important;
      outline-offset: 2px !important;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);

  let selectedElement: Element | null = null;

  const clear = () => {
    selectedElement?.removeAttribute(SELECTED_ATTRIBUTE);
    selectedElement = null;
    onSelectionChange(null);
  };

  const handleClick = (event: MouseEvent) => {
    const view = doc.defaultView;
    if (!view || event.button !== 0 || !(event.target instanceof view.Element)) return;
    event.preventDefault();
    event.stopPropagation();

    const target = event.target;
    if (selectedElement === target) {
      clear();
      return;
    }

    selectedElement?.removeAttribute(SELECTED_ATTRIBUTE);
    selectedElement = target;
    selectedElement.setAttribute(SELECTED_ATTRIBUTE, '');
    onSelectionChange(describeHtmlElement(selectedElement));
  };

  doc.addEventListener('click', handleClick, true);

  return {
    clear,
    destroy: () => {
      doc.removeEventListener('click', handleClick, true);
      selectedElement?.removeAttribute(SELECTED_ATTRIBUTE);
      selectedElement = null;
      style.remove();
    },
    getSelectedElement: () => selectedElement,
  };
}
