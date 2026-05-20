import type {
  BrowserDomSnapshot,
  BrowserTab,
  BrowserTargetRef,
  BrowserTargetRefRecord,
} from './types';

interface RawBrowserInteractiveElement {
  tag: string;
  role?: string | null;
  text: string;
  ariaLabel?: string | null;
  placeholder?: string | null;
  selectorHint: string;
  refConfidence: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserDomSnapshotBuildResult {
  snapshot: BrowserDomSnapshot;
  targetRefRecords: BrowserTargetRefRecord[];
}

export async function buildBrowserDomSnapshot(args: {
  tab: BrowserTab;
  snapshotId: string;
  capturedAtMs: number;
  targetRefTtlMs: number;
}): Promise<BrowserDomSnapshotBuildResult> {
  const { tab, snapshotId, capturedAtMs, targetRefTtlMs } = args;
  const page = tab.page;
  const headingsPromise = page.$$eval('h1,h2,h3,h4,h5,h6', (nodes) =>
    nodes.slice(0, 30).map((node) => ({
      level: Number(node.tagName.replace(/^H/i, '')) || 0,
      text: node.textContent?.trim().slice(0, 160) || '',
    })).filter((item) => item.text)
  ).catch((): BrowserDomSnapshot['headings'] => []);
  const interactiveElementsPromise = page.$$eval(
    'button, a[href], input, select, textarea, [role], [onclick], [tabindex]',
    (nodes) => nodes.slice(0, 80).map((node) => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const id = el.getAttribute('id');
      const className = el.getAttribute('class');
      const tag = el.tagName.toLowerCase();
      const escapeCss = (value: string) => {
        const css = (globalThis as typeof globalThis & { CSS?: { escape?: (input: string) => string } }).CSS;
        if (css?.escape) {
          return css.escape(value);
        }
        return value.replace(/(["\\#.:,[\]=\s>+~*])/g, '\\$1');
      };
      const quotedAttr = (name: string, value: string) => `[${name}="${value.replace(/(["\\])/g, '\\$1')}"]`;
      const selectorHint = (() => {
        if (id) return `#${escapeCss(id)}`;
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
        if (testId) return quotedAttr(el.getAttribute('data-testid') ? 'data-testid' : 'data-test', testId);
        const name = el.getAttribute('name');
        if (name && /^(input|select|textarea|button)$/i.test(tag)) {
          return `${tag}${quotedAttr('name', name)}`;
        }
        if (className) {
          const firstClass = className.split(/\s+/).filter(Boolean)[0];
          if (firstClass) return `${tag}.${escapeCss(firstClass)}`;
        }
        const parts: string[] = [];
        let current: HTMLElement | null = el;
        while (current?.nodeType === Node.ELEMENT_NODE) {
          const currentTag = current.tagName.toLowerCase();
          const currentTagName = current.tagName;
          const parent: HTMLElement | null = current.parentElement;
          if (!parent) {
            parts.unshift(currentTag);
            break;
          }
          const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === currentTagName);
          const nth = sameTagSiblings.indexOf(current) + 1;
          parts.unshift(sameTagSiblings.length > 1 ? `${currentTag}:nth-of-type(${nth})` : currentTag);
          if (parent === document.body || parent === document.documentElement) {
            break;
          }
          current = parent;
        }
        return parts.join(' > ') || tag;
      })();
      return {
        tag,
        role: el.getAttribute('role'),
        text: el.textContent?.trim().slice(0, 160) || '',
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder'),
        selectorHint,
        refConfidence: id ? 0.95 : className ? 0.65 : 0.45,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    }).filter((item) => item.rect.width > 0 && item.rect.height > 0)
  ).catch((): RawBrowserInteractiveElement[] => []);
  const [headings, rawInteractiveElements] = await Promise.all([
    headingsPromise,
    interactiveElementsPromise,
  ]);
  const currentUrl = page.url();
  const targetRefRecords: BrowserTargetRefRecord[] = [];
  const interactiveElements = rawInteractiveElements.map((element, index) => {
    const targetRef: BrowserTargetRef = {
      refId: `tref_${snapshotId}_${index + 1}`,
      source: 'dom',
      selector: element.selectorHint,
      role: element.role,
      name: element.ariaLabel || element.text || element.placeholder || element.selectorHint,
      textHint: element.text || element.ariaLabel || element.placeholder || null,
      frameId: null,
      tabId: tab.id,
      snapshotId,
      capturedAtMs,
      ttlMs: targetRefTtlMs,
      confidence: element.refConfidence,
    };
    targetRefRecords.push({
      targetRef,
      url: currentUrl,
    });
    const { refConfidence: _refConfidence, ...publicElement } = element;
    return {
      ...publicElement,
      targetRef,
    };
  });

  return {
    snapshot: {
      snapshotId,
      tabId: tab.id,
      capturedAtMs,
      url: currentUrl,
      title: await page.title(),
      headings,
      interactiveElements,
    },
    targetRefRecords,
  };
}
