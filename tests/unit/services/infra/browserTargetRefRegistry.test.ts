import { describe, expect, it, vi } from 'vitest';
import { BrowserTargetRefRegistry } from '../../../../src/host/services/infra/browser/targetRefRegistry';
import type {
  BrowserTab,
  BrowserTargetRef,
} from '../../../../src/host/services/infra/browser/types';

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

function fakeTab(options: {
  tabId?: string;
  resolveFails?: boolean;
  runtimeCalls?: Array<Record<string, unknown>>;
  domCalls?: Array<{ method: string; params: Record<string, unknown> }>;
  mouseClicks?: Array<{ x: number; y: number }>;
} = {}): BrowserTab {
  const runtimeCalls = options.runtimeCalls || [];
  const session = {
    async send(method: string, params: Record<string, unknown>) {
      if (method.startsWith('DOM.')) options.domCalls?.push({ method, params });
      if (method === 'DOM.resolveNode') {
        if (options.resolveFails) throw new Error('No node with given id');
        return { object: { objectId: 'node-object-42' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        runtimeCalls.push(params);
        const declaration = String(params.functionDeclaration);
        if (declaration.includes('documentUrl')) {
          return { result: { value: { connected: true, documentUrl: 'https://frame.test/' } } };
        }
        return { result: { value: true } };
      }
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.getBoxModel') {
        return { model: { border: [10, 20, 110, 20, 110, 70, 10, 70] } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected CDP method: ${method}`);
    },
    async detach() {},
  };
  return {
    id: options.tabId || 'tab-owner',
    url: 'https://example.test/',
    title: 'Example',
    page: {
      url: () => 'https://example.test/',
      $: vi.fn(async () => ({ dispose: async () => undefined })),
      context: () => ({ newCDPSession: async () => session }),
      mouse: {
        click: async (x: number, y: number) => options.mouseClicks?.push({ x, y }),
      },
    } as unknown as BrowserTab['page'],
  };
}

describe('BrowserTargetRefRegistry owner and document fences', () => {
  it('uses a unique opaque snapshot namespace across concurrent registries', () => {
    const alpha = new BrowserTargetRefRegistry();
    const beta = new BrowserTargetRefRegistry();

    expect(alpha.createSnapshotId()).not.toBe(beta.createSnapshotId());
  });

  it('rejects a foreign ref and conflicting Host identity fields', async () => {
    const alpha = new BrowserTargetRefRegistry();
    const beta = new BrowserTargetRefRegistry();
    const alphaSnapshot = alpha.createSnapshotId();
    const betaSnapshot = beta.createSnapshotId();
    const alphaRef = targetRef(alphaSnapshot, 'tab-alpha');
    const betaRef = targetRef(betaSnapshot, 'tab-beta');
    alpha.addRecords([record(alphaRef)]);
    beta.addRecords([record(betaRef)]);

    await expect(beta.resolve(alphaRef, () => fakeTab({ tabId: 'tab-beta' }))).rejects.toMatchObject({
      code: 'STALE_TARGET_REF',
    });
    await expect(beta.resolve({ ...betaRef, tabId: 'tab-alpha' }, () => fakeTab({ tabId: 'tab-beta' })))
      .rejects.toMatchObject({ code: 'STALE_TARGET_REF' });
    await expect(beta.resolve({ ...betaRef, backendNodeId: 7 }, () => fakeTab({ tabId: 'tab-beta' })))
      .rejects.toMatchObject({ code: 'STALE_TARGET_REF' });
    await expect(beta.resolve({ ...betaRef, frameId: 'FRAME_FOREIGN' }, () => fakeTab({ tabId: 'tab-beta' })))
      .rejects.toMatchObject({ code: 'STALE_TARGET_REF' });
    await expect(beta.resolve({ ...betaRef, documentRevision: 'document-old' }, () => fakeTab({ tabId: 'tab-beta' })))
      .rejects.toMatchObject({ code: 'STALE_TARGET_REF' });
  });

  it('resolves a child-frame ref by backend node identity without selector fallback', async () => {
    const registry = new BrowserTargetRefRegistry();
    const ref = targetRef(registry.createSnapshotId());
    registry.addRecords([record(ref)]);
    const tab = fakeTab();

    await expect(registry.resolve(ref, () => tab)).resolves.toMatchObject({ targetRef: ref });
    expect(tab.page.$).not.toHaveBeenCalled();
  });

  it('executes real pointer click and fill against the exact resolved backend object', async () => {
    const registry = new BrowserTargetRefRegistry();
    const ref = targetRef(registry.createSnapshotId());
    const runtimeCalls: Array<Record<string, unknown>> = [];
    const mouseClicks: Array<{ x: number; y: number }> = [];
    const tab = fakeTab({ mouseClicks, runtimeCalls });
    registry.addRecords([record(ref)]);

    await expect(registry.click(ref, () => tab)).resolves.toEqual(ref);
    await expect(registry.fill(ref, 'updated', () => tab)).resolves.toEqual(ref);

    expect(mouseClicks).toEqual([{ x: 60, y: 45 }]);
    expect(runtimeCalls.some((call) => (
      String(call.functionDeclaration).includes('HTMLInputElement')
      && JSON.stringify(call.arguments) === JSON.stringify([{ value: 'updated' }])
    ))).toBe(true);
    expect(tab.page.$).not.toHaveBeenCalled();
  });

  it('resolves hover and drag coordinates from the exact backend node box', async () => {
    const registry = new BrowserTargetRefRegistry();
    const ref = targetRef(registry.createSnapshotId());
    const domCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const tab = fakeTab({ domCalls });
    registry.addRecords([record(ref)]);

    await expect(registry.resolveBounds(ref, () => tab)).resolves.toEqual({
      targetRef: ref,
      bounds: { x: 10, y: 20, width: 100, height: 50 },
    });
    await expect(registry.resolveBounds(ref, () => tab, undefined, {
      scrollIntoView: false,
    })).resolves.toEqual({
      targetRef: ref,
      bounds: { x: 10, y: 20, width: 100, height: 50 },
    });
    expect(domCalls.map((call) => call.method)).toEqual([
      'DOM.resolveNode',
      'DOM.scrollIntoViewIfNeeded',
      'DOM.getBoxModel',
      'DOM.resolveNode',
      'DOM.getBoxModel',
    ]);
    expect(domCalls[1]?.params).toEqual({ backendNodeId: 42 });
    expect(tab.page.$).not.toHaveBeenCalled();
  });

  it('fails closed when an OOPIF ref has no resolvable backend identity', async () => {
    const registry = new BrowserTargetRefRegistry();
    const ref = { ...targetRef(registry.createSnapshotId()), backendNodeId: undefined };
    registry.addRecords([record(ref)]);

    await expect(registry.resolve(ref, () => fakeTab())).rejects.toMatchObject({
      code: 'STALE_TARGET_REF',
      message: expect.stringContaining('unavailable OOPIF'),
    });
  });

  it('invalidates a backend identity after same-URL document replacement', async () => {
    const registry = new BrowserTargetRefRegistry();
    const ref = targetRef(registry.createSnapshotId());
    registry.addRecords([record(ref)]);

    await expect(registry.resolve(ref, () => fakeTab({ resolveFails: true }))).rejects.toMatchObject({
      code: 'STALE_TARGET_REF',
      message: expect.stringContaining('cannot be safely resolved'),
    });
  });

  it('supersedes every older snapshot when a fresh snapshot is registered', async () => {
    const registry = new BrowserTargetRefRegistry();
    const previous = targetRef(registry.createSnapshotId());
    const current = targetRef(registry.createSnapshotId());
    registry.addRecords([record(previous)]);
    registry.addRecords([record(current)]);

    await expect(registry.resolve(previous, () => fakeTab())).rejects.toMatchObject({
      code: 'STALE_TARGET_REF',
    });
    await expect(registry.resolve(current, () => fakeTab())).resolves.toMatchObject({
      targetRef: current,
    });
  });
});
