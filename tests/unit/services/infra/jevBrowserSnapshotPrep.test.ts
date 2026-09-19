import { describe, expect, it } from 'vitest';
import { parseBrowserDomSnapshot } from '../../../../src/host/services/infra/browser/domSnapshotParser';
import {
  prepareJevBrowserSnapshot,
  type JevCapturedSnapshot,
} from '../../../../src/host/services/infra/browser/jevBrowserSnapshotPrep';
import type { BrowserDomSnapshot } from '../../../../src/host/services/infra/browser/types';

function element(
  id: string,
  text: string,
  rect: { x: number; y: number; width: number; height: number },
  extra?: { role?: string; tag?: string; placeholder?: string },
): BrowserDomSnapshot['interactiveElements'][number] {
  return {
    tag: extra?.tag || 'button',
    role: extra?.role || 'button',
    text,
    ariaLabel: text,
    placeholder: extra?.placeholder || null,
    selectorHint: `#${id}`,
    targetRef: {
      refId: id,
      source: 'dom',
      selector: `#${id}`,
      role: extra?.role || 'button',
      name: text,
      textHint: text,
      frameId: 'FRAME',
      documentRevision: 'rev',
      tabId: 'tab',
      snapshotId: 'snap',
      capturedAtMs: 1,
      ttlMs: 60_000,
      confidence: 0.9,
      rect,
    },
    rect,
  };
}

function captured(
  elements: BrowserDomSnapshot['interactiveElements'],
  extras: JevCapturedSnapshot['extras'],
  scrollY = 0,
): JevCapturedSnapshot {
  return {
    snapshot: {
      snapshotId: 'snap',
      tabId: 'tab',
      capturedAtMs: 1,
      url: 'http://127.0.0.1/dense',
      title: 'Dense',
      headings: [{ level: 1, text: 'Shop' }],
      interactiveElements: elements,
    },
    extras,
    viewport: { width: 800, height: 600 },
    scrollY,
  };
}

describe('jevBrowserSnapshotPrep', () => {
  it('selectCandidateWindow 顶 254，超出截断', () => {
    const elements = Array.from({ length: 300 }, (_, index) => element(
      `tref_${index}`,
      `Nav ${index}`,
      { x: 0, y: index * 20, width: 40, height: 16 },
      { role: 'link', tag: 'a' },
    ));
    const extras = elements.map(() => ({ inputType: null, autocomplete: null, accept: null }));
    const prepared = prepareJevBrowserSnapshot(captured(elements, extras), 'open nav');
    expect(prepared.selected).toHaveLength(254);
    expect(prepared.window.truncated).toBe(true);
  });

  it('密码和文件字段丢弃，只留 sensitive_fields_present', () => {
    const page = captured(
      [
        element('tref_ok', 'Submit', { x: 0, y: 10, width: 80, height: 20 }),
        element('tref_pw', 'Password', { x: 0, y: 40, width: 80, height: 20 }, { tag: 'input', role: 'textbox' }),
        element('tref_file', 'Upload', { x: 0, y: 70, width: 80, height: 20 }, { tag: 'input', role: 'button' }),
      ],
      [
        { inputType: null, autocomplete: null, accept: null },
        { inputType: 'password', autocomplete: 'current-password', accept: null },
        { inputType: 'file', autocomplete: null, accept: '.txt' },
      ],
    );
    const prepared = prepareJevBrowserSnapshot(page, 'read the title');
    expect(prepared.sensitiveFieldsPresent).toBe(true);
    expect(prepared.selected.map((candidate) => candidate.refId)).toEqual(['tref_ok']);
    expect(JSON.stringify(prepared.selected)).not.toMatch(/password/i);
  });

  it('密页：折页下 Checkout 因词交叠进窗口，采集可超过 80', () => {
    const elements = [
      ...Array.from({ length: 90 }, (_, index) => element(
        `tref_nav_${index}`,
        'Nav',
        { x: 0, y: index * 8, width: 40, height: 8 },
        { role: 'link', tag: 'a' },
      )),
      element('tref_checkout', 'Checkout now', { x: 0, y: 4000, width: 120, height: 32 }),
    ];
    const extras = elements.map(() => ({ inputType: null, autocomplete: null, accept: null }));
    const page = captured(elements, extras, 0);
    const prepared = prepareJevBrowserSnapshot(page, 'click Checkout now until Paid');
    expect(prepared.collected.length).toBeGreaterThan(80);
    expect(prepared.selected.some((candidate) => candidate.refId === 'tref_checkout')).toBe(true);
    const checkout = prepared.selected.find((candidate) => candidate.refId === 'tref_checkout');
    expect(checkout?.score).toBeGreaterThan(40);
  });

  it('parseBrowserDomSnapshot 默认仍 80，可抬到 1024', () => {
    const strings = ['https://x.test/', 'T', 'FRAME', '#document', 'HTML', 'BODY', 'BUTTON', '#text', 'Go'];
    const indexOf = (value: string) => strings.indexOf(value);
    const nodeName = [indexOf('#document'), indexOf('HTML'), indexOf('BODY')];
    const parentIndex = [-1, 0, 1];
    const nodeValue = ['', '', ''].map(() => 0);
    const backendNodeId = [1, 2, 3];
    const attributes: number[][] = [[], [], []];
    const layoutIndex: number[] = [];
    const bounds: number[][] = [];
    for (let n = 0; n < 90; n += 1) {
      const nodeIndex = 3 + n * 2;
      nodeName.push(indexOf('BUTTON'), indexOf('#text'));
      parentIndex.push(2, nodeIndex);
      nodeValue.push(0, indexOf('Go'));
      backendNodeId.push(10 + n, 100 + n);
      attributes.push([], []);
      layoutIndex.push(nodeIndex);
      bounds.push([0, n * 10, 40, 8]);
    }
    const payload = {
      strings,
      documents: [{
        documentURL: indexOf('https://x.test/'),
        title: indexOf('T'),
        frameId: indexOf('FRAME'),
        nodes: { parentIndex, nodeName, nodeValue, backendNodeId, attributes },
        layout: { nodeIndex: layoutIndex, bounds },
      }],
    };
    const capped = parseBrowserDomSnapshot({
      payload,
      snapshotId: 's',
      tabId: 't',
      pageUrl: 'https://x.test/',
      capturedAtMs: 1,
      targetRefTtlMs: 60_000,
    });
    expect(capped.interactiveElements).toHaveLength(80);
    const wide = parseBrowserDomSnapshot({
      payload,
      snapshotId: 's',
      tabId: 't',
      pageUrl: 'https://x.test/',
      capturedAtMs: 1,
      targetRefTtlMs: 60_000,
      maxInteractiveElements: 1024,
    });
    expect(wide.interactiveElements.length).toBeGreaterThan(80);
  });
});
