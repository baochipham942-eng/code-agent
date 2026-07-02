import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const emitMock = vi.fn();
let tauri = true;

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ emit: emitMock }));
vi.mock('../../../src/renderer/utils/platform', () => ({ isTauriMode: () => tauri }));

async function freshModule() {
  vi.resetModules();
  return import('../../../src/renderer/utils/rendererReady');
}

/**
 * renderer-ready 主通道是 invoke command：emit 事件通道在打包态实测投递不到壳侧
 * (window.once/app.once 都收不到)，窗口只能死等超时兜底。invoke 是直连调用不走
 * 事件路由；emit 保留为兜底副通道（壳侧 AtomicBool 去重，双发无害）。
 */
describe('signalRendererReady', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockClear();
    emitMock.mockResolvedValue(undefined);
    tauri = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('在 Tauri 模式下 invoke 一次 renderer_ready command', async () => {
    const { signalRendererReady } = await freshModule();
    await signalRendererReady();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('renderer_ready');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('invoke 失败时回退 emit renderer-ready 事件', async () => {
    invokeMock.mockRejectedValueOnce(new Error('command not found'));
    const { signalRendererReady } = await freshModule();
    await signalRendererReady();
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('renderer-ready');
  });

  it('幂等:重复调用只发一次', async () => {
    const { signalRendererReady } = await freshModule();
    await signalRendererReady();
    await signalRendererReady();
    await signalRendererReady();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('非 Tauri 模式下不发信号(不抛)', async () => {
    tauri = false;
    const { signalRendererReady } = await freshModule();
    await expect(signalRendererReady()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('invoke 和 emit 都抛错时静默吞掉(壳侧有超时兜底)', async () => {
    invokeMock.mockRejectedValueOnce(new Error('bridge unavailable'));
    emitMock.mockRejectedValueOnce(new Error('bridge unavailable'));
    const { signalRendererReady } = await freshModule();
    await expect(signalRendererReady()).resolves.toBeUndefined();
  });
});
