import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 用 vi.mock 替换 localBridge store（renderToStaticMarkup 下读不到运行时状态），
// 让组件在静态渲染下拿到受控 token——沿用本仓 captureAddDialog 等测试的 mock 手法。
vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: () => ({
    token: 'test-token',
    setWorkingDirectory: () => {},
  }),
}));

import { DirectoryPickerModal } from '../../../src/renderer/components/features/chat/DirectoryPickerModal';

// 验证 DirectoryPickerModal 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('DirectoryPickerModal (Modal primitive 迁移验证)', () => {
  it('关闭态：不渲染任何弹窗', () => {
    const html = renderToStaticMarkup(
      <DirectoryPickerModal isOpen={false} onSelect={() => {}} onClose={() => {}} />
    );
    expect(html).toBe('');
  });

  it('开启态：走 Modal primitive（role=dialog + aria-modal），标题/描述/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <DirectoryPickerModal isOpen={true} onSelect={() => {}} onClose={() => {}} />
    );

    // Modal primitive 提供的无障碍契约（手搓版本没有）
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');

    // 标题（由自定义 header 渲染）
    expect(html).toContain('选择工作目录');

    // 描述与 footer 动作保留
    expect(html).toContain('请选择一个工作目录');
    expect(html).toContain('取消');
    expect(html).toContain('确认');
  });
});
