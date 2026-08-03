import { describe, expect, it, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
const ensureCanvasRunMock = vi.fn();
const saveCanvasDocMock = vi.fn();
const readImageMock = vi.fn();

vi.mock('../../../src/renderer/components/design/designCanvasPersistence', () => ({
  ensureCanvasRun: () => ensureCanvasRunMock(),
  saveCanvasDoc: (...a: unknown[]) => saveCanvasDocMock(...a),
}));
vi.mock('../../../src/renderer/components/design/designFiles', () => ({
  readWorkspaceImageAsDataUrl: (p: string) => readImageMock(p),
  resolveDesignDir: vi.fn(),
}));
vi.mock('../../../src/renderer/components/design/useDesignCanvasGeneration', () => ({
  loadImageDims: async () => ({ width: 800, height: 600 }),
  nextVariantNodeId: () => 'node-test-1',
}));

import { importAssetToCanvas } from '../../../src/renderer/components/design/importAssetToCanvas';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';

describe('importAssetToCanvas — 对话图产物 →「修改」→ 落画布', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDesignCanvasStore.setState({ nodes: [], selectedIds: [], camera: { x: 0, y: 0, scale: 1 } });
    ensureCanvasRunMock.mockResolvedValue('/design/run-1');
    readImageMock.mockResolvedValue('data:image/png;base64,QUJD');
    invokeMock.mockResolvedValue({ success: true, data: { path: '/design/run-1/assets/x.png' } });
    (globalThis as unknown as { window: unknown }).window = { domainAPI: { invoke: invokeMock } };
  });

  it('空路径直接拒绝，不发起任何 IPC（对话里有些图只有 url 没有本地文件）', async () => {
    const r = await importAssetToCanvas('   ');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('本地文件路径');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(ensureCanvasRunMock).not.toHaveBeenCalled();
  });

  it('走 importDesignImageFromPath 而不是 dataURL 那条——源在设计目录外，必须过源路径守卫', async () => {
    await importAssetToCanvas('/workspace/artifacts/images/a.png');
    const [, action, payload] = invokeMock.mock.calls[0];
    expect(action).toBe('importDesignImageFromPath');
    expect(payload.sourcePath).toBe('/workspace/artifacts/images/a.png');
    expect(payload.outputPath).toMatch(/^\/design\/run-1\/.*from-chat-\d+\.png$/);
  });

  it('扩展名跟随源文件，取不到时按 png 兜底', async () => {
    await importAssetToCanvas('/w/a.JPEG');
    expect(invokeMock.mock.calls[0][2].outputPath).toMatch(/\.jpeg$/);
    invokeMock.mockClear();
    await importAssetToCanvas('/w/no-ext');
    expect(invokeMock.mock.calls[0][2].outputPath).toMatch(/\.png$/);
  });

  it('成功后节点落画布并被选中——用户点「修改」的意图就是马上动手改它', async () => {
    const r = await importAssetToCanvas('/w/a.png');
    expect(r.ok).toBe(true);
    const st = useDesignCanvasStore.getState();
    expect(st.nodes).toHaveLength(1);
    expect(st.nodes[0]).toMatchObject({ src: expect.stringContaining('from-chat-'), width: 800, height: 600 });
    expect(st.selectedIds).toEqual([st.nodes[0].id]);
    expect(saveCanvasDocMock).toHaveBeenCalledTimes(1);
  });

  it('IPC 失败时透出 host 的原话，且不落节点（不能只留一半状态）', async () => {
    invokeMock.mockResolvedValue({ success: false, error: { message: 'sourcePath 路径越界：必须位于当前工作目录或设计目录内' } });
    const r = await importAssetToCanvas('/etc/passwd.png');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('路径越界');
    expect(useDesignCanvasStore.getState().nodes).toHaveLength(0);
    expect(saveCanvasDocMock).not.toHaveBeenCalled();
  });

  it('拿不到画布 run 时不发起 IPC', async () => {
    ensureCanvasRunMock.mockResolvedValue(null);
    const r = await importAssetToCanvas('/w/a.png');
    expect(r.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
