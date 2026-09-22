// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { enSettingsCore } from '../../../src/renderer/i18n/enSettingsCore';
import { zhSettingsCore } from '../../../src/renderer/i18n/zhSettingsCore';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async () => ({
      config: {
        enabled: true,
        warningThreshold: 0.75,
        preserveRecentCount: 10,
        compactProvider: 'moonshot',
        compactModel: 'kimi-k2.5',
        auditEnabled: true,
      },
      runtime: {
        compressionCount: 0,
        totalSavedTokens: 0,
        recentStrategies: [],
      },
      compactModel: {
        provider: 'moonshot',
        model: 'kimi-k2.5',
        configured: true,
      },
      features: {
        audit: 'enabled',
        manifest: 'enabled',
        hooks: 'available',
      },
    })),
  },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));

import { ConversationSettings } from '../../../src/renderer/components/features/settings/tabs/ConversationSettings';

describe('ConversationSettings compression knobs', () => {
  afterEach(() => {
    cleanup();
  });

  it('drops the Clean at slider and keeps the knobs that have a host consumer', async () => {
    useAppStore.setState({ language: 'zh' });
    expect(zhSettingsCore.conversation.details).not.toHaveProperty('criticalThreshold');
    expect(enSettingsCore.conversation.details).not.toHaveProperty('criticalThreshold');

    render(React.createElement(ConversationSettings));

    await waitFor(() => {
      expect(document.body.textContent).toContain('开始提醒');
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('最近保留');
    expect(text).toContain('强制整理点');
    expect(text).toContain('整理留痕');
    expect(text).toContain('自动整理长对话');
    expect(text).not.toContain('主动整理');
    expect(text).not.toContain('Clean at');
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(1);
  });
});
