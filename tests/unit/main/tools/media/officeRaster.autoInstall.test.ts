// ============================================================================
// isLibreOfficeAvailable 的进程内一次自动安装触发 — N-PY-RUNTIME-K3 rework r1
//
// officeRaster 的模块级 autoInstallTriggered 标志保证：候选表为空时每次调用都
// 同步返回 false（走既有降级，绝不阻塞），后台每进程至多触发一次 ensureLibreOffice；
// 失败后同进程不自动重触发（重试只能走 prepareRuntimeAssets）。这里用 mock ensure
// + 注入的空候选表钉住该契约，零网络。模块级标志用 vi.resetModules + 动态 import 隔离。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
}));

vi.mock('../../../../../src/host/runtime/libreOffice/ensure', () => ({
  ensureLibreOffice: (...args: unknown[]) => h.ensure(...args),
}));
// 注入空候选表：无论宿主机是否装有系统 LibreOffice，可用性判定恒为 false。
vi.mock('../../../../../src/host/runtime/libreOffice/lookup', () => ({
  getLibreOfficeCandidates: () => [],
  findLibreOfficePath: () => null,
}));

async function importOfficeRaster() {
  return await import('../../../../../src/host/tools/media/officeRaster');
}

beforeEach(() => {
  vi.resetModules();
  h.ensure.mockReset();
  delete process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL;
});

afterEach(() => {
  // tests/setup.ts 的全局防线（既有测试不下载任何东西）测试后必须恢复
  process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL = '1';
});

describe('isLibreOfficeAvailable 后台自动安装触发（每进程一次）', () => {
  it('候选表为空：两次调用都同步返回 false，ensure 至多触发一次（永不 resolve 也不重复）', async () => {
    h.ensure.mockImplementation(() => new Promise(() => {}));
    const { isLibreOfficeAvailable } = await importOfficeRaster();

    expect(isLibreOfficeAvailable()).toBe(false);
    expect(isLibreOfficeAvailable()).toBe(false);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('首次触发失败（ensure 落定 ok:false）后，后续调用不再自动重触发', async () => {
    h.ensure.mockResolvedValue({
      ok: false,
      root: '/tmp/neo-libreoffice-root',
      error: { code: 'LIBREOFFICE_RUNTIME_INSTALL_FAILED', message: 'install failed', retryable: true, logPath: '/tmp/neo-libreoffice-root/install.log' },
    });
    const { isLibreOfficeAvailable } = await importOfficeRaster();

    expect(isLibreOfficeAvailable()).toBe(false);
    // 触发是 void 后台调用，flush 微任务让 ensure 落定
    await vi.waitFor(() => expect(h.ensure).toHaveBeenCalledTimes(1));
    expect(isLibreOfficeAvailable()).toBe(false);
    expect(isLibreOfficeAvailable()).toBe(false);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('CODE_AGENT_NO_RUNTIME_AUTOINSTALL=1 时不触发后台安装', async () => {
    process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL = '1';
    const { isLibreOfficeAvailable } = await importOfficeRaster();

    expect(isLibreOfficeAvailable()).toBe(false);
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
