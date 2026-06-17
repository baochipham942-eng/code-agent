import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 用 vi.mock 替换 zustand store（renderToStaticMarkup 下 useSyncExternalStore 读不到运行时状态），
// 让 useCaptureStore() 直接返回受控状态——沿用本仓 settingsModal 等测试的 mock 手法。
const mockState = vi.hoisted(() => ({ open: true }));
vi.mock('../../../src/renderer/stores/captureStore', () => ({
  useCaptureStore: () => ({
    isAddDialogOpen: mockState.open,
    setAddDialogOpen: (v: boolean) => {
      mockState.open = v;
    },
    captureItem: async () => true,
  }),
}));

import { CaptureAddDialog } from '../../../src/renderer/components/features/capture/CaptureAddDialog';

// 验证 CaptureAddDialog 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('CaptureAddDialog (Modal primitive 迁移验证)', () => {
  it('关闭态：不渲染任何弹窗', () => {
    mockState.open = false;
    const html = renderToStaticMarkup(<CaptureAddDialog />);
    expect(html).toBe('');
  });

  it('开启态：走 Modal primitive（role=dialog + aria-modal），标题/四字段/footer 齐全', () => {
    mockState.open = true;
    const html = renderToStaticMarkup(<CaptureAddDialog />);

    // Modal primitive 提供的无障碍契约（手搓版本没有）
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');

    // 标题由 Modal header 渲染
    expect(html).toContain('添加知识条目');

    // 四个表单字段保留
    expect(html).toContain('标题');
    expect(html).toContain('内容');
    expect(html).toContain('标签');
    expect(html).toContain('URL');

    // footer 走 Button primitive
    expect(html).toContain('取消');
    expect(html).toContain('添加');
  });
});
