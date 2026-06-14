import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
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
    ]) {
      expect(html).toContain(text);
    }

    expect(html).not.toContain('sk-proj-');
    expect(html).not.toContain('bot-token');
    expect(html).not.toContain('appSecret=');
  });
});
