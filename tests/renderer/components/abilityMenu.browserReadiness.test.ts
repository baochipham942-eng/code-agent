import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSessionMode, ConversationRoutingMode } from '../../../src/shared/contract/conversationEnvelope';

const composerState: {
  routingMode: ConversationRoutingMode;
  browserSessionMode: BrowserSessionMode;
  setRoutingMode: (mode: ConversationRoutingMode) => void;
  setBrowserSessionMode: (mode: BrowserSessionMode) => void;
} = {
  routingMode: 'auto',
  browserSessionMode: 'none',
  setRoutingMode: vi.fn((mode: ConversationRoutingMode) => {
    composerState.routingMode = mode;
  }),
  setBrowserSessionMode: vi.fn((mode: BrowserSessionMode) => {
    composerState.browserSessionMode = mode;
  }),
};

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (state: typeof composerState) => unknown) =>
    selector(composerState),
}));

import { AbilityMenu } from '../../../src/renderer/components/features/chat/ChatInput/AbilityMenu';

describe('AbilityMenu browser readiness', () => {
  beforeEach(() => {
    composerState.routingMode = 'auto';
    composerState.browserSessionMode = 'desktop';
    vi.clearAllMocks();
  });

  it('renders unprobed permissions separately from denied permissions', () => {
    const html = renderToStaticMarkup(
      React.createElement(AbilityMenu, {
        defaultOpen: true,
        browserSession: {
          managedSession: {
            running: false,
            tabCount: 0,
            activeTab: null,
          },
          computerSurface: {
            id: 'surface-1',
            mode: 'foreground_fallback',
            platform: 'darwin',
            ready: true,
            background: false,
            requiresForeground: true,
            approvalScope: 'session_app',
            safetyNote: 'Computer Surface 会作用于当前前台 app/window；没有后台隔离。',
            approvedApps: [],
            deniedApps: [],
          },
          preview: {
            mode: 'desktop',
            frontmostApp: 'Google Chrome',
            title: 'Docs',
            url: 'https://example.com/docs',
            surfaceMode: 'foreground_fallback',
          },
          readinessItems: [
            {
              key: 'screenCapture',
              label: 'Screen Capture',
              ready: false,
              value: '未探测',
              tone: 'neutral',
              detail: '屏幕录制尚未主动探测。',
            },
            {
              key: 'accessibility',
              label: 'Accessibility',
              ready: false,
              value: '未授权',
              tone: 'blocked',
              detail: '辅助功能未授权。',
            },
          ],
          blocked: true,
          blockedDetail: '当前桌面浏览器上下文未就绪：屏幕录制未确认、辅助功能未授权。',
          blockedHint: '先确认权限并启动采集。',
          repairActions: [
            {
              kind: 'open_screen_capture_settings',
              label: '检查/授权屏幕录制',
            },
            {
              kind: 'open_accessibility_settings',
              label: '授权辅助功能',
            },
          ],
          busyActionKind: null,
          actionError: null,
          runRepairAction: vi.fn(async () => undefined),
        },
      }),
    );

    expect(html).toContain('Computer surface');
    expect(html).toContain('Foreground fallback (current window)');
    expect(html).toContain('Computer Surface 会作用于当前前台 app/window；没有后台隔离。');
    expect(html).toContain('Screen Capture');
    expect(html).toContain('未探测');
    expect(html).toContain('Accessibility');
    expect(html).toContain('未授权');
    expect(html).toContain('当前桌面浏览器上下文未就绪：屏幕录制未确认、辅助功能未授权。');
    expect(html).toContain('检查/授权屏幕录制');
    expect(html).toContain('授权辅助功能');
    expect(html).toContain('text-zinc-300');
    expect(html).toContain('text-amber-300');
  });
});
