import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';

// 验证 ChannelModal 从手搓 fixed-inset-0 表单弹窗迁移到 Modal primitive 后行为不回归
describe('ChannelModal (Modal primitive 迁移验证)', () => {
  it('新增态：走 Modal primitive（role=dialog + aria-modal），标题/字段/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <ChannelModal channelTypes={[]} onSave={() => {}} onClose={() => {}} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // 标题由 Modal header 渲染
    expect(html).toContain('添加通道');
    // 表单字段保留
    expect(html).toContain('名称');
    expect(html).toContain('隐私策略');
    // footer 走 Button primitive
    expect(html).toContain('取消');
    expect(html).toContain('添加');
  });
});
