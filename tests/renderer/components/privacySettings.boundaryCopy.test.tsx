// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const openExternalLink = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
  openExternalLink,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

describe('PrivacySettings boundary copy', () => {
  it('renders privacy boundary, voice paths and auth inventory without raw secrets', () => {
    const html = renderToStaticMarkup(
      React.createElement(PrivacySettings, { onNavigateSettings: vi.fn() }),
    );

    for (const text of [
      '桌面采集与控制',
      '语音和转写',
      '外部通道',
      'MCP 和插件',
      '模型供应商和 API Key',
      'Memory',
      '遥测和诊断包',
      '聊天语音输入',
      'Voice Paste',
      'MCP OAuth 授权',
      '浏览器 Relay Token',
      '第三方界面插件',
      '允许第三方插件显示界面',
      '权限和 Neo 本身一样大',
      '查看数据流与能力边界说明',
    ]) {
      expect(html).toContain(text);
    }

    expect(html).not.toContain('sk-proj-');
    expect(html).not.toContain('bot-token');
    expect(html).not.toContain('appSecret=');
  });

  it('opens the public NOTICE page through the platform helper', () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(React.createElement(PrivacySettings, { onNavigateSettings: vi.fn() }));
    const link = screen.getByRole('link', { name: '查看数据流与能力边界说明' });
    fireEvent.click(link);
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/baochipham942-eng/code-agent/blob/main/docs/NOTICE.md',
    );
  });
});
