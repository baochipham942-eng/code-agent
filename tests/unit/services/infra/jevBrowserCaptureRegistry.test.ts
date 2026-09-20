import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserTab,
  BrowserTargetRef,
} from '../../../../src/host/services/infra/browser/types';
import { BrowserTargetRefRegistry } from '../../../../src/host/services/infra/browser/targetRefRegistry';

const buildBrowserDomSnapshot = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/services/infra/browser/domSnapshotBuilder', () => ({
  buildBrowserDomSnapshot,
}));

import { captureJevPageFromTab } from '../../../../src/host/services/infra/browser/jevBrowserSnapshotPrep';

function record(targetRef: BrowserTargetRef) {
  return {
    targetRef,
    url: 'https://example.test/',
    documentUrl: 'https://frame.test/',
  };
}

function targetRef(snapshotId: string, tabId = 'tab-owner'): BrowserTargetRef {
  return {
    refId: `tref_${snapshotId}_1`,
    source: 'dom',
    selector: '#save',
    frameId: 'FRAME_CHILD',
    documentRevision: `document_${snapshotId}_FRAME_CHILD`,
    tabId,
    snapshotId,
    capturedAtMs: Date.now(),
    ttlMs: 30_000,
    confidence: 1,
    backendNodeId: 42,
  };
}

function fakeTab(): BrowserTab {
  const session = {
    async send(method: string) {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-object-42' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { connected: true, documentUrl: 'https://frame.test/' } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected CDP method: ${method}`);
    },
    async detach() {},
  };
  return {
    id: 'tab-owner',
    url: 'https://example.test/',
    title: 'Example',
    page: {
      url: () => 'https://example.test/',
      viewportSize: () => ({ width: 1280, height: 720 }),
      evaluate: async () => 0,
      context: () => ({ newCDPSession: async () => session }),
    } as unknown as BrowserTab['page'],
  };
}

describe('captureJevPageFromTab registry namespace', () => {
  beforeEach(() => {
    buildBrowserDomSnapshot.mockReset();
  });

  it('内环跑两步后 fallback，主模型步前 tref 仍可解析', async () => {
    const registry = new BrowserTargetRefRegistry();
    const mainRef = targetRef(registry.createSnapshotId());
    registry.addRecords([record(mainRef)]);
    const tab = fakeTab();

    const innerOne = targetRef(registry.createSnapshotId());
    const innerTwo = targetRef(registry.createSnapshotId());
    buildBrowserDomSnapshot
      .mockResolvedValueOnce({
        snapshot: {
          snapshotId: innerOne.snapshotId,
          tabId: 'tab-owner',
          capturedAtMs: Date.now(),
          url: 'https://example.test/',
          title: 'Inner 1',
          headings: [],
          interactiveElements: [],
        },
        targetRefRecords: [record(innerOne)],
        elementExtras: [],
      })
      .mockResolvedValueOnce({
        snapshot: {
          snapshotId: innerTwo.snapshotId,
          tabId: 'tab-owner',
          capturedAtMs: Date.now(),
          url: 'https://example.test/',
          title: 'Inner 2',
          headings: [],
          interactiveElements: [],
        },
        targetRefRecords: [record(innerTwo)],
        elementExtras: [],
      });

    await captureJevPageFromTab({ tab, registry });
    await captureJevPageFromTab({ tab, registry });

    await expect(registry.resolve(mainRef, () => tab)).resolves.toMatchObject({ targetRef: mainRef });
    await expect(registry.resolve(innerTwo, () => tab)).resolves.toMatchObject({ targetRef: innerTwo });
  });
});
