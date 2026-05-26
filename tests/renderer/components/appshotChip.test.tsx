import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppshotCapture } from '../../../src/shared/contract/appshot';

vi.mock('../../../src/renderer/components/primitives', () => ({
  IconButton: ({ 'aria-label': ariaLabel, onClick, icon, className }: any) => (
    <button aria-label={ariaLabel} onClick={onClick} className={className}>{icon}</button>
  ),
  Modal: ({ isOpen, children, header }: any) => (isOpen ? <div>{header}{children}</div> : null),
}));

import { AppshotChip } from '../../../src/renderer/components/features/chat/ChatInput/AppshotChip';

const capture: AppshotCapture = {
  requestId: 'appshot-1',
  appName: 'TextEdit',
  bundleId: 'com.apple.TextEdit',
  windowTitle: 'Untitled',
  screenshotPath: '/tmp/appshot-1.png',
  screenshotDataUrl: 'data:image/png;base64,abc',
  axText: 'window text',
  textSource: 'ax',
  windowFrame: { x: 0, y: 0, width: 600, height: 400 },
  capturedAtMs: 100,
};

describe('AppshotChip', () => {
  it('renders the chip as a preview entry point with removable capture metadata', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture,
        onRemove: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="查看 Appshot"');
    expect(html).toContain('aria-label="移除 Appshot"');
    expect(html).toContain('TextEdit');
    expect(html).toContain('Untitled');
    expect(html).toContain('已读取窗口文字');
  });
});
