// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { zh } from '../../../src/renderer/i18n/zh';

const channelsText = zh.settings.channels;

afterEach(cleanup);

// 验证 ChannelModal 从手搓 fixed-inset-0 表单弹窗迁移到 Modal primitive 后行为不回归
describe('ChannelModal (Modal primitive 迁移验证)', () => {
  it('新增态：走 Modal primitive（role=dialog + aria-modal），标题/字段/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <ChannelModal channelTypes={[]} onSave={() => {}} onClose={() => {}} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // 标题由 Modal header 渲染
    expect(html).toContain(channelsText.modal.addTitle);
    // 表单字段保留
    expect(html).toContain(channelsText.modal.nameLabel);
    expect(html).toContain(channelsText.modal.privacyModeLabel);
    // footer 走 Button primitive
    expect(html).toContain(channelsText.actions.cancel);
    expect(html).toContain(channelsText.actions.add);
  });

  it('新建飞书账号默认启用长连接，并提交出站白名单', () => {
    const onSave = vi.fn();
    render(
      <ChannelModal
        channelTypes={[{ type: 'feishu', name: '飞书' }]}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'feishu' } });
    const longConnection = screen.getByRole('checkbox', { name: channelsText.modal.webSocketLabel });
    expect((longConnection as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(channelsText.modal.outboundTargetsHint)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.outboundTargetsPlaceholder), {
      target: { value: 'oc_one, oc_two' },
    });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      type: 'feishu',
      config: expect.objectContaining({
        useWebSocket: true,
        outboundAllowlist: ['oc_one', 'oc_two'],
      }),
    }));
  });
});
