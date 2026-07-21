import { describe, expect, it, vi } from 'vitest';
import { buildBrowserDomSnapshot } from '../../../../src/host/services/infra/browser/domSnapshotBuilder';
import { parseBrowserDomSnapshot } from '../../../../src/host/services/infra/browser/domSnapshotParser';
import type { BrowserTab } from '../../../../src/host/services/infra/browser/types';

function snapshotPayload() {
  const strings = [
    'https://main.test/', 'Main title', 'FRAME_MAIN', '#document', 'HTML', 'BODY',
    'BUTTON', 'id', 'main', '#text', 'Main', 'DIV', '#document-fragment', 'open',
    'shadow', 'Shadow', 'https://frame.test/', 'Frame title', 'FRAME_CHILD', 'inner', 'Inner',
  ];
  const index = (value: string) => strings.indexOf(value);
  return {
    strings,
    documents: [
      {
        documentURL: index('https://main.test/'),
        title: index('Main title'),
        frameId: index('FRAME_MAIN'),
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3, 2, 5, 6, 7],
          nodeName: ['#document', 'HTML', 'BODY', 'BUTTON', '#text', 'DIV', '#document-fragment', 'BUTTON', '#text'].map(index),
          nodeValue: ['', '', '', '', 'Main', '', '', '', 'Shadow'].map(index),
          backendNodeId: [1, 2, 3, 42, 5, 6, 7, 43, 9],
          attributes: [[], [], [], [index('id'), index('main')], [], [], [], [index('id'), index('shadow')], []],
          shadowRootType: { index: [6], value: [index('open')] },
        },
        layout: {
          nodeIndex: [3, 7],
          bounds: [[10, 20, 100, 30], [20, 70, 120, 35]],
        },
      },
      {
        documentURL: index('https://frame.test/'),
        title: index('Frame title'),
        frameId: index('FRAME_CHILD'),
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3],
          nodeName: ['#document', 'HTML', 'BODY', 'BUTTON', '#text'].map(index),
          nodeValue: ['', '', '', '', 'Inner'].map(index),
          backendNodeId: [80, 81, 82, 84, 85],
          attributes: [[], [], [], [index('id'), index('inner')], []],
        },
        layout: { nodeIndex: [3], bounds: [[5, 8, 90, 25]] },
      },
    ],
  };
}

describe('buildBrowserDomSnapshot', () => {
  it('issues real CDP frame/backend identities and observes iframe plus open Shadow DOM nodes', async () => {
    const pageSession = {
      send: vi.fn(async (method: string) => {
        if (method !== 'DOMSnapshot.captureSnapshot') throw new Error(`Unexpected method: ${method}`);
        return snapshotPayload();
      }),
      detach: vi.fn(async () => undefined),
    };
    const browserSession = {
      send: vi.fn(async (method: string) => {
        if (method !== 'Target.getTargets') throw new Error(`Unexpected method: ${method}`);
        return {
          targetInfos: [{
            targetId: 'FRAME_OOPIF',
            type: 'iframe',
            title: 'OOPIF',
            url: 'https://oopif.test/',
            attached: true,
            canAccessOpener: false,
            parentFrameId: 'FRAME_MAIN',
          }],
        };
      }),
      detach: vi.fn(async () => undefined),
    };
    const browser = { newBrowserCDPSession: vi.fn(async () => browserSession) };
    const context = {
      newCDPSession: vi.fn(async () => pageSession),
      browser: () => browser,
    };
    const page = {
      context: () => context,
      url: () => 'https://main.test/',
      title: async () => 'Main title',
    };
    const tab = { id: 'tab-1', page } as unknown as BrowserTab;

    const result = await buildBrowserDomSnapshot({
      tab,
      snapshotId: 'snapshot-1',
      capturedAtMs: 100,
      targetRefTtlMs: 30_000,
    });

    expect(result.snapshot.interactiveElements).toMatchObject([
      { text: 'Main', backendNodeId: 42, targetRef: { frameId: 'FRAME_MAIN' } },
      { text: 'Shadow', backendNodeId: 43, shadowRoot: true, targetRef: { frameId: 'FRAME_MAIN' } },
      { text: 'Inner', backendNodeId: 84, targetRef: { frameId: 'FRAME_CHILD' } },
    ]);
    expect(result.snapshot.frameDocuments).toEqual([
      expect.objectContaining({ frameId: 'FRAME_MAIN', status: 'captured' }),
      expect.objectContaining({ frameId: 'FRAME_CHILD', status: 'captured' }),
      expect.objectContaining({
        frameId: 'FRAME_OOPIF',
        status: 'unavailable',
        reason: 'oopif_requires_dedicated_cdp_session',
      }),
    ]);
    expect(result.targetRefRecords).toMatchObject([
      { documentUrl: 'https://main.test/', targetRef: { backendNodeId: 42 } },
      { documentUrl: 'https://main.test/', targetRef: { backendNodeId: 43 } },
      { documentUrl: 'https://frame.test/', targetRef: { backendNodeId: 84 } },
    ]);
    expect(pageSession.send).toHaveBeenCalledWith('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
    });
  });

  it('keeps open Shadow DOM refs but filters closed and user-agent descendants fail-closed', () => {
    const strings = [
      'https://main.test/',
      'Main title',
      'FRAME_MAIN',
      '#document',
      'HTML',
      'BODY',
      'DIV',
      'id',
      'role',
      'button',
      'closed-host',
      '#document-fragment',
      'closed',
      'BUTTON',
      'closed-action',
      '#text',
      'CLOSED_SECRET_TEXT',
      'user-agent-host',
      'user-agent',
      'user-agent-action',
      'USER_AGENT_SECRET_TEXT',
      'open-host',
      'open',
      'open-action',
      'Open action',
    ];
    const index = (value: string) => strings.indexOf(value);
    const result = parseBrowserDomSnapshot({
      payload: {
        strings,
        documents: [{
          documentURL: index('https://main.test/'),
          title: index('Main title'),
          frameId: index('FRAME_MAIN'),
          nodes: {
            parentIndex: [-1, 0, 1, 2, 3, 4, 5, 2, 7, 8, 9, 2, 11, 12, 13],
            nodeName: [
              '#document',
              'HTML',
              'BODY',
              'DIV',
              '#document-fragment',
              'BUTTON',
              '#text',
              'DIV',
              '#document-fragment',
              'BUTTON',
              '#text',
              'DIV',
              '#document-fragment',
              'BUTTON',
              '#text',
            ].map(index),
            nodeValue: [
              '', '', '', '', '', '', 'CLOSED_SECRET_TEXT',
              '', '', '', 'USER_AGENT_SECRET_TEXT',
              '', '', '', 'Open action',
            ].map(index),
            backendNodeId: [
              1, 2, 3, 40, 41, 42, 43,
              50, 51, 52, 53,
              60, 61, 62, 63,
            ],
            attributes: [
              [], [], [],
              [index('id'), index('closed-host'), index('role'), index('button')],
              [],
              [index('id'), index('closed-action')],
              [],
              [index('id'), index('user-agent-host'), index('role'), index('button')],
              [],
              [index('id'), index('user-agent-action')],
              [],
              [index('id'), index('open-host')],
              [],
              [index('id'), index('open-action')],
              [],
            ],
            shadowRootType: {
              index: [4, 8, 12],
              value: [index('closed'), index('user-agent'), index('open')],
            },
          },
          layout: {
            nodeIndex: [3, 5, 7, 9, 13],
            bounds: [
              [10, 10, 100, 30],
              [20, 20, 80, 20],
              [10, 50, 100, 30],
              [20, 60, 80, 20],
              [20, 100, 100, 30],
            ],
          },
        }],
      },
      snapshotId: 'snapshot-shadow-policy',
      tabId: 'tab-shadow-policy',
      pageUrl: 'https://main.test/',
      capturedAtMs: 100,
      targetRefTtlMs: 30_000,
    });

    expect(result.interactiveElements).toMatchObject([
      {
        selectorHint: '#closed-host',
        text: '',
        targetRef: { backendNodeId: 40 },
      },
      {
        selectorHint: '#user-agent-host',
        text: '',
        targetRef: { backendNodeId: 50 },
      },
      {
        selectorHint: '#open-action',
        text: 'Open action',
        shadowRoot: true,
        targetRef: { backendNodeId: 62 },
      },
    ]);
    expect(result.interactiveElements).toHaveLength(3);
    expect(result.targetRefRecords.map((record) => record.targetRef.backendNodeId))
      .toEqual([40, 50, 62]);
    expect(JSON.stringify(result)).not.toContain('CLOSED_SECRET_TEXT');
    expect(JSON.stringify(result)).not.toContain('USER_AGENT_SECRET_TEXT');
  });
});
