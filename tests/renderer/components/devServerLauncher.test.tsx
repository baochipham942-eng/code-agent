import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// useAppStore 以 selector 形式调用，mock 成受控状态；ipcService 仅在 handler 用，mock 防导入副作用。
const mockState = vi.hoisted(() => ({ open: true }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  // useI18n 无 selector 整取 store,组件本体带 selector 取——两种调用形状都要接住
  useAppStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      devServerLauncherOpen: mockState.open,
      closeDevServerLauncher: () => {},
      openLivePreview: () => {},
      language: 'zh',
      setLanguage: () => {},
      cloudUIStrings: undefined,
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invokeDomain: async () => ({}),
  default: { invoke: async () => ({}) },
}));

import { DevServerLauncher } from '../../../src/renderer/components/LivePreview/DevServerLauncher';

// 验证 DevServerLauncher 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('DevServerLauncher (Modal primitive 迁移验证)', () => {
  it('关闭态：不渲染任何弹窗', () => {
    mockState.open = false;
    const html = renderToStaticMarkup(<DevServerLauncher />);
    expect(html).toBe('');
  });

  it('开启态：走 Modal primitive（role=dialog + aria-modal），标题/字段/footer 齐全', () => {
    mockState.open = true;
    const html = renderToStaticMarkup(<DevServerLauncher />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('启动 Dev Server');
    expect(html).toContain('项目目录');
    expect(html).toContain('选目录');
    expect(html).toContain('取消');
    expect(html).toContain('启动');
  });
});
