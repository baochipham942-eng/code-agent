// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// 侧栏可见性只跟 sidebarCollapsed 走，不跟披露档位走（rework r2）。
//  背景：isSidebarVisible 曾是 `isStandard && !sidebarCollapsed`——披露档位
//  一旦从设置页可调（r1 起外观 tab 有入口），选「简洁」会把整个左栏（会话列表、
//  新任务、账号菜单）一起藏掉，用户失去导航。档位只该管聊天过程呈现的繁简
//  （workDetailPolicy），不该动导航骨架。
//  这里直接渲染完整 App（jsdom）：断言任一档位下侧栏容器与会话列表/新任务
//  入口都在场；侧栏的唯一隐藏途径仍是「收起」。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('../../../src/renderer/utils/platform', () => ({
  isDesktopShellMode: () => false,
  isTauriMode: () => false,
  isWebMode: () => true,
}));

// jsdom 缺 matchMedia（App 的 useTheme/布局 hooks 会用），补最小实现
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
// jsdom 也没有 ResizeObserver（react-resizable-panels 的 PanelGroup 会 new），补空壳
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// 视口宽于 SIDEBAR_AUTO_COLLAPSE_WIDTH，避免窄屏自动收起干扰「未收起」语义
const REAL_INNER_WIDTH = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { value: REAL_INNER_WIDTH, configurable: true, writable: true });
});

import { App } from '../../../src/renderer/App';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('侧栏可见性不随披露档位变化', () => {
  it.each(['simple', 'standard', 'advanced', 'expert'] as const)('%s 档：侧栏容器、会话列表与新任务入口都在场', (level) => {
    useAppStore.setState({ disclosureLevel: level, sidebarCollapsed: false });
    const { container, getByTestId } = render(<App />);

    // 侧栏内层 w-60 定宽壳已挂载（外层裁切壳常驻，收起只改宽度不卸载）
    expect(container.querySelector('.w-60.h-full')).toBeTruthy();
    // 新任务入口（会话列表上方的常驻行）
    expect(getByTestId('sidebar-new-task')).toBeTruthy();
    // 会话列表滚动容器
    expect(getByTestId('sidebar-session-scroll')).toBeTruthy();
  });

  it('简洁档收起侧栏：唯一隐藏途径仍是「收起」（壳挂载、内容被裁切）', () => {
    useAppStore.setState({ disclosureLevel: 'simple', sidebarCollapsed: true });
    const { container } = render(<App />);

    // 收起 = 外层壳宽度裁到 0 + aria-hidden，组件仍挂载（宽度过渡的常驻挂载设计）
    const shell = container.querySelector('.w-60.h-full');
    expect(shell).toBeTruthy();
    const pane = shell?.parentElement;
    expect(pane?.getAttribute('aria-hidden')).toBe('true');
    expect(pane?.className).toContain('w-0');
  });
});
