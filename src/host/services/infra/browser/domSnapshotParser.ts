import type {
  BrowserDomSnapshot,
  BrowserTargetRef,
  BrowserTargetRefRecord,
} from './types';

interface RareStringData {
  index: number[];
  value: number[];
}

interface CdpNodeTreeSnapshot {
  parentIndex?: number[];
  shadowRootType?: RareStringData;
  nodeName?: number[];
  nodeValue?: number[];
  backendNodeId?: number[];
  attributes?: number[][];
  isClickable?: { index: number[] };
}

interface CdpDocumentSnapshot {
  documentURL: number;
  title: number;
  frameId: number;
  nodes: CdpNodeTreeSnapshot;
  layout: {
    nodeIndex: number[];
    bounds: number[][];
  };
}

export interface CdpDomSnapshotPayload {
  documents: CdpDocumentSnapshot[];
  strings: string[];
}

export interface ParsedBrowserDomSnapshot {
  headings: BrowserDomSnapshot['headings'];
  interactiveElements: BrowserDomSnapshot['interactiveElements'];
  targetRefRecords: BrowserTargetRefRecord[];
  frameDocuments: NonNullable<BrowserDomSnapshot['frameDocuments']>;
}

function documentRevision(snapshotId: string, frameId: string): string {
  return `document_${snapshotId}_${frameId}`;
}

function indexedString(strings: string[], index: number | undefined): string {
  return typeof index === 'number' && strings[index] ? strings[index] : '';
}

function attributesForNode(
  nodes: CdpNodeTreeSnapshot,
  strings: string[],
  nodeIndex: number,
): Record<string, string> {
  const flattened = nodes.attributes?.[nodeIndex] || [];
  const attributes: Record<string, string> = {};
  for (let index = 0; index + 1 < flattened.length; index += 2) {
    const name = indexedString(strings, flattened[index]).toLowerCase();
    if (name) attributes[name] = indexedString(strings, flattened[index + 1]);
  }
  return attributes;
}

function selectorHint(tag: string, attributes: Record<string, string>): {
  confidence: number;
  selector: string;
} {
  const quoted = (name: string, value: string) => (
    `[${name}="${value.replace(/(["\\])/g, '\\$1')}"]`
  );
  if (attributes.id) {
    return {
      confidence: 0.95,
      selector: `#${attributes.id.replace(/(["\\#.:,[\]=\s>+~*])/g, '\\$1')}`,
    };
  }
  const testAttribute = attributes['data-testid']
    ? 'data-testid'
    : attributes['data-test'] ? 'data-test' : null;
  if (testAttribute) {
    return { confidence: 0.9, selector: quoted(testAttribute, attributes[testAttribute]) };
  }
  if (attributes.name && /^(button|input|select|textarea)$/.test(tag)) {
    return { confidence: 0.75, selector: `${tag}${quoted('name', attributes.name)}` };
  }
  const firstClass = attributes.class?.split(/\s+/).find(Boolean);
  if (firstClass) {
    return {
      confidence: 0.6,
      selector: `${tag}.${firstClass.replace(/(["\\#.:,[\]=\s>+~*])/g, '\\$1')}`,
    };
  }
  return { confidence: 0.4, selector: tag };
}

function childrenByParent(nodes: CdpNodeTreeSnapshot): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (let index = 0; index < (nodes.parentIndex?.length || 0); index += 1) {
    const parent = nodes.parentIndex?.[index];
    if (!Number.isSafeInteger(parent) || (parent as number) < 0) continue;
    const siblings = children.get(parent as number) || [];
    siblings.push(index);
    children.set(parent as number, siblings);
  }
  return children;
}

function nodeText(
  nodes: CdpNodeTreeSnapshot,
  strings: string[],
  children: Map<number, number[]>,
  rootIndex: number,
  blockedShadowNodes: ReadonlySet<number>,
): string {
  const parts: string[] = [];
  const pending = [...(children.get(rootIndex) || [])];
  while (pending.length > 0 && parts.join(' ').length < 200) {
    const index = pending.shift() as number;
    if (blockedShadowNodes.has(index)) continue;
    if (indexedString(strings, nodes.nodeName?.[index]) === '#text') {
      const value = indexedString(strings, nodes.nodeValue?.[index]).trim();
      if (value) parts.push(value);
    }
    pending.push(...(children.get(index) || []));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function shadowDescendants(
  nodes: CdpNodeTreeSnapshot,
  strings: string[],
): {
  blocked: Set<number>;
  open: Set<number>;
} {
  const shadowRootModes = new Map<number, string>();
  nodes.shadowRootType?.index.forEach((nodeIndex, valueIndex) => {
    if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0) return;
    shadowRootModes.set(nodeIndex, indexedString(
      strings,
      nodes.shadowRootType?.value[valueIndex],
    ));
  });
  // Chromium marks nodes flattened from a shadow tree directly; older protocol
  // shapes may instead mark only a shadow-root ancestor, so walk the complete
  // parent chain. Any closed, user-agent, or future unknown mode is blocked.
  const blocked = new Set<number>();
  const open = new Set<number>();
  const nodeCount = Math.max(
    nodes.parentIndex?.length || 0,
    nodes.nodeName?.length || 0,
  );
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    let cursor = nodeIndex;
    let insideShadow = false;
    let blockedByMode = false;
    while (cursor >= 0) {
      const mode = shadowRootModes.get(cursor);
      if (mode !== undefined) {
        insideShadow = true;
        if (mode !== 'open') blockedByMode = true;
      }
      cursor = nodes.parentIndex?.[cursor] ?? -1;
    }
    if (blockedByMode) blocked.add(nodeIndex);
    else if (insideShadow) open.add(nodeIndex);
  }
  return { blocked, open };
}

function layoutBounds(document: CdpDocumentSnapshot): Map<number, BrowserTargetRef['rect']> {
  const result = new Map<number, BrowserTargetRef['rect']>();
  document.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
    const [x, y, width, height] = document.layout.bounds[layoutIndex] || [];
    if (![x, y, width, height].every(Number.isFinite)) return;
    result.set(nodeIndex, {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  });
  return result;
}

function isInteractiveElement(
  tag: string,
  attributes: Record<string, string>,
  clickable: Set<number>,
  nodeIndex: number,
): boolean {
  return tag === 'button'
    || (tag === 'a' && Boolean(attributes.href))
    || tag === 'input'
    || tag === 'select'
    || tag === 'textarea'
    || Boolean(attributes.role)
    || Object.hasOwn(attributes, 'onclick')
    || Object.hasOwn(attributes, 'tabindex')
    || clickable.has(nodeIndex);
}

export function parseBrowserDomSnapshot(args: {
  payload: CdpDomSnapshotPayload;
  snapshotId: string;
  tabId: string;
  pageUrl: string;
  capturedAtMs: number;
  targetRefTtlMs: number;
}): ParsedBrowserDomSnapshot {
  const { payload, snapshotId, tabId, pageUrl, capturedAtMs, targetRefTtlMs } = args;
  const headings: BrowserDomSnapshot['headings'] = [];
  const interactiveElements: BrowserDomSnapshot['interactiveElements'] = [];
  const targetRefRecords: BrowserTargetRefRecord[] = [];
  const frameDocuments: NonNullable<BrowserDomSnapshot['frameDocuments']> = [];

  for (const document of payload.documents) {
    const frameId = indexedString(payload.strings, document.frameId);
    if (!frameId) continue;
    const revision = documentRevision(snapshotId, frameId);
    const documentUrl = indexedString(payload.strings, document.documentURL);
    frameDocuments.push({ frameId, documentRevision: revision, url: documentUrl, status: 'captured' });
    const nodes = document.nodes;
    const children = childrenByParent(nodes);
    const bounds = layoutBounds(document);
    const clickable = new Set(nodes.isClickable?.index || []);
    const shadow = shadowDescendants(nodes, payload.strings);
    const nodeCount = nodes.nodeName?.length || 0;

    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
      if (shadow.blocked.has(nodeIndex)) continue;
      const tag = indexedString(payload.strings, nodes.nodeName?.[nodeIndex]).toLowerCase();
      const text = nodeText(
        nodes,
        payload.strings,
        children,
        nodeIndex,
        shadow.blocked,
      );
      if (/^h[1-6]$/.test(tag) && text && headings.length < 30) {
        headings.push({
          level: Number(tag.slice(1)),
          text,
          frameId,
          documentRevision: revision,
        });
      }
      if (interactiveElements.length >= 80) continue;
      const attributes = attributesForNode(nodes, payload.strings, nodeIndex);
      if (!isInteractiveElement(tag, attributes, clickable, nodeIndex)) continue;
      const rect = bounds.get(nodeIndex);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const hint = selectorHint(tag, attributes);
      const backendNodeId = nodes.backendNodeId?.[nodeIndex];
      const ariaLabel = attributes['aria-label'] || null;
      const placeholder = attributes.placeholder || null;
      const targetRef: BrowserTargetRef = {
        refId: `tref_${snapshotId}_${interactiveElements.length + 1}`,
        source: 'dom',
        selector: hint.selector,
        role: attributes.role || null,
        name: ariaLabel || text || placeholder || hint.selector,
        textHint: text || ariaLabel || placeholder,
        frameId,
        documentRevision: revision,
        tabId,
        snapshotId,
        capturedAtMs,
        ttlMs: targetRefTtlMs,
        confidence: hint.confidence,
        ...(Number.isSafeInteger(backendNodeId) ? { backendNodeId } : {}),
        rect,
      };
      targetRefRecords.push({ targetRef, url: pageUrl, documentUrl });
      interactiveElements.push({
        tag,
        role: attributes.role || null,
        text,
        ariaLabel,
        placeholder,
        selectorHint: hint.selector,
        targetRef,
        ...(Number.isSafeInteger(backendNodeId) ? { backendNodeId } : {}),
        ...(shadow.open.has(nodeIndex) ? { shadowRoot: true } : {}),
        rect,
      });
    }
  }

  return { headings, interactiveElements, targetRefRecords, frameDocuments };
}
