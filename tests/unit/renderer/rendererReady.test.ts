import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitMock = vi.fn();
let tauri = true;

vi.mock('@tauri-apps/api/event', () => ({ emit: emitMock }));
vi.mock('../../../src/renderer/utils/platform', () => ({ isTauriMode: () => tauri }));

async function freshModule() {
  vi.resetModules();
  return import('../../../src/renderer/utils/rendererReady');
}

describe('signalRendererReady', () => {
  beforeEach(() => {
    emitMock.mockClear();
    tauri = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('在 Tauri 模式下 emit 一次 renderer-ready', async () => {
    const { signalRendererReady } = await freshModule();
    await signalRendererReady();
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('renderer-ready');
  });

  it('幂等:重复调用只 emit 一次', async () => {
    const { signalRendererReady } = await freshModule();
    await signalRendererReady();
    await signalRendererReady();
    await signalRendererReady();
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it('非 Tauri 模式下不 emit(不抛)', async () => {
    tauri = false;
    const { signalRendererReady } = await freshModule();
    await expect(signalRendererReady()).resolves.toBeUndefined();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('emit 抛错时静默吞掉(壳侧有超时兜底)', async () => {
    emitMock.mockRejectedValueOnce(new Error('bridge unavailable'));
    const { signalRendererReady } = await freshModule();
    await expect(signalRendererReady()).resolves.toBeUndefined();
  });
});
