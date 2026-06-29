// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';

// 隔离 Tauri 插件（仅在 IPC 桥不可用时才回退到它）
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  openNativeUrl: vi.fn(() => Promise.resolve()),
  openNativePath: vi.fn(() => Promise.resolve()),
}));

import { openExternalLink } from '../../../src/renderer/utils/platform';

describe('openExternalLink 走 webServer IPC 桥（修 bug A）', () => {
  const invoke = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    invoke.mockClear();
    (window as unknown as { domainAPI?: unknown }).domainAPI = { invoke };
  });

  it('http(s) 外链 → workspace:openExternal（不依赖 __TAURI_INTERNALS__）', () => {
    expect(openExternalLink('https://github.com/anthropics/claude-code/releases')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('workspace', 'openExternal', {
      url: 'https://github.com/anthropics/claude-code/releases',
    });
  });

  it('file:// 本地文件 → workspace:openPath（去掉 file://）', () => {
    expect(openExternalLink('file:///tmp/a.html')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('workspace', 'openPath', { filePath: '/tmp/a.html' });
  });

  it('空 href → false（不拦截）', () => {
    expect(openExternalLink(undefined)).toBe(false);
    expect(openExternalLink('')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('无 domainAPI 且非 Tauri → false（web 由原生 <a> 接管在别处判定）', () => {
    (window as unknown as { domainAPI?: unknown }).domainAPI = undefined;
    expect(openExternalLink('https://x.com')).toBe(false);
  });
});
