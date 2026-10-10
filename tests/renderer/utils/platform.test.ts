// @vitest-environment jsdom
// N-PRIVACY-WEB-SECTIONS 验收④锚点：Tauri 生产壳下 isWebMode 必须是 false
// （utils/platform.ts 里 isTauriMode 早退在 __CODE_AGENT_TOKEN__ 判定之前），
// 桌面渲染不受 web 降级影响；缺口只在浏览器 web 链路。
import { afterEach, describe, expect, it, vi } from 'vitest';

// platform.ts 顶层 import 了 Tauri 插件门面，这里只需它可加载
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  openNativeUrl: vi.fn(() => Promise.resolve()),
  openNativePath: vi.fn(() => Promise.resolve()),
}));

import { isTauriMode, isWebMode } from '../../../src/renderer/utils/platform';

function setWindowKey(key: string, value: unknown): void {
  const host = window as unknown as Record<string, unknown>;
  if (value === undefined) delete host[key];
  else host[key] = value;
}

afterEach(() => {
  setWindowKey('__TAURI_INTERNALS__', undefined);
  setWindowKey('__CODE_AGENT_TOKEN__', undefined);
});

describe('isWebMode 的 Tauri 早退（生产桌面壳不受 web 降级影响）', () => {
  it('__TAURI_INTERNALS__ 在场 → isTauriMode true、isWebMode false，即便 webServer 注入了 __CODE_AGENT_TOKEN__', () => {
    setWindowKey('__TAURI_INTERNALS__', {});
    setWindowKey('__CODE_AGENT_TOKEN__', 'token');
    expect(isTauriMode()).toBe(true);
    expect(isWebMode()).toBe(false);
  });

  it('无 Tauri 全局但有 __CODE_AGENT_TOKEN__ → isWebMode true（浏览器 web 链路才吃降级）', () => {
    setWindowKey('__CODE_AGENT_TOKEN__', 'token');
    expect(isTauriMode()).toBe(false);
    expect(isWebMode()).toBe(true);
  });
});
