import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import {
  canvasDocToDesignDoc,
  designDocPath,
  loadDesignDoc,
} from '../../../src/renderer/components/design/designDocPersistence';
import { saveCanvasDoc } from '../../../src/renderer/components/design/designCanvasPersistence';
import type {
  CanvasImageNode,
  CanvasVideoNode,
  DesignCanvasDoc,
} from '../../../src/renderer/components/design/designCanvasTypes';

const image = (over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id: 'hero',
  src: 'assets/hero.png',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  prompt: '首页首屏',
  parentId: 'root',
  chosen: true,
  costCny: 0.14,
  createdAt: 1,
  ...over,
});

const video = (over: Partial<CanvasVideoNode> = {}): CanvasVideoNode => ({
  id: 'motion',
  kind: 'video',
  src: 'assets/motion.mp4',
  x: 400,
  y: 20,
  width: 320,
  height: 180,
  durationSec: 5,
  createdAt: 2,
  ...over,
});

const doc = (nodes = [image()]): DesignCanvasDoc => ({
  version: 1,
  camera: { x: 1, y: 2, scale: 1.5 },
  nodes,
});

function installDomainMock() {
  const writes = new Map<string, string>();
  const invoke = vi.fn(async (domain: string, action: string, payload: { filePath?: string; content?: string }) => {
    expect(domain).toBe(IPC_DOMAINS.WORKSPACE);
    if (action === 'writeFile' && payload.filePath && payload.content !== undefined) {
      writes.set(payload.filePath, payload.content);
      return { success: true, data: { path: payload.filePath } };
    }
    if (action === 'readFile' && payload.filePath) {
      return { success: writes.has(payload.filePath), data: writes.get(payload.filePath) };
    }
    return { success: false };
  });
  (globalThis as unknown as { window: { domainAPI: { invoke: typeof invoke } } }).window = {
    domainAPI: { invoke },
  };
  return { invoke, writes };
}

describe('designDocPersistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('converts canvas nodes into a structured DesignDoc layer tree', () => {
    const designDoc = canvasDocToDesignDoc(doc([image(), video()]));
    expect(designDoc.medium).toBe('video');
    expect(designDoc.metadata).toMatchObject({ source: 'canvas.json', nodeCount: 2, activeNodeCount: 2 });
    const frame = designDoc.pages[0].frames[0];
    expect(frame.bounds).toEqual({ x: 10, y: 20, width: 710, height: 200 });
    expect(frame.layers.map((layer) => [layer.id, layer.kind, layer.src])).toEqual([
      ['canvas-node:hero', 'image', 'assets/hero.png'],
      ['canvas-node:motion', 'media', 'assets/motion.mp4'],
    ]);
    expect(frame.layers[0].metadata).toMatchObject({
      canvasNodeId: 'hero',
      parentId: 'root',
      chosen: true,
      costCny: 0.14,
    });
    expect(designDoc.provenance[0]).toMatchObject({
      id: 'canvas-provenance:hero',
      source: 'ai',
      prompt: '首页首屏',
    });
  });

  it('saveCanvasDoc writes canvas.json and design-doc.json side by side', async () => {
    const { writes } = installDomainMock();
    const ok = await saveCanvasDoc('/tmp/design/run-a', doc());
    expect(ok).toBe(true);
    expect([...writes.keys()].sort()).toEqual([
      '/tmp/design/run-a/canvas.json',
      '/tmp/design/run-a/design-doc.json',
    ]);
    const parsed = JSON.parse(writes.get('/tmp/design/run-a/design-doc.json') ?? '{}');
    expect(parsed.pages[0].frames[0].layers[0]).toMatchObject({
      id: 'canvas-node:hero',
      kind: 'image',
      src: 'assets/hero.png',
    });
  });

  it('loadDesignDoc reads the sidecar document safely', async () => {
    const { writes } = installDomainMock();
    writes.set(designDocPath('/tmp/design/run-b'), JSON.stringify(canvasDocToDesignDoc(doc())));
    const loaded = await loadDesignDoc('/tmp/design/run-b/');
    expect(loaded.pages[0].frames[0].layers[0].id).toBe('canvas-node:hero');
  });
});
