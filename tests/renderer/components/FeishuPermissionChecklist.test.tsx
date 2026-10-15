// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const initialLanguage = useAppStore.getState().language;
afterEach(() => {
  cleanup();
  useAppStore.setState({ language: initialLanguage });
});

describe('Feishu setup permission checklist', () => {
  it.each([
    ['zh', true], ['zh', false], ['en', true], ['en', false],
  ] as const)('shows approval and no-mention scope in %s (WebSocket=%s)', (language, useWebSocket) => {
    useAppStore.setState({ language });
    render(<ChannelModal
      account={{
        id: 'test-account', name: 'Test Feishu', type: 'feishu', status: 'disconnected', enabled: true, createdAt: 1,
        config: { type: 'feishu', appId: 'test-app', appSecret: '', useWebSocket },
      }}
      channelTypes={[{ type: 'feishu', name: 'Feishu' }]}
      onSave={vi.fn()} onClose={vi.fn()}
    />);
    const checklist = screen.getByRole('region', { name: language === 'zh' ? '权限清单' : 'Permission checklist' });
    expect(checklist.textContent).toContain('im:message.group_msg');
    expect(checklist.textContent).toContain(language === 'zh' ? '租户管理员批准' : 'tenant administrator approval');
    expect(checklist.textContent).toContain(language === 'zh' ? '仅在无需 @ 的群监听中需要' : 'only needed for group listening without @mentions');
    expect(checklist.textContent).toContain(language === 'zh' ? '申请并发布版本' : 'Request it and publish a version');
  });
});
