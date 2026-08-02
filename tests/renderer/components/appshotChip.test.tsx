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
  textReady: true,
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
    // 纯截图卡：app 名/窗口标题只在 alt/title 提示里，不占文字行
    expect(html).toContain('TextEdit');
    expect(html).toContain('Untitled');
    // 文字已就绪时不显示「识别中…」
    expect(html).not.toContain('识别中…');
  });

  it('shows a soft recognizing pill until text_ready arrives', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture: { ...capture, textReady: false, textSource: 'none', axText: null },
        onRemove: () => undefined,
      }),
    );

    expect(html).toContain('识别中…');
  });

  it('stays invisible while reserved for the fly-in handoff', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture,
        onRemove: () => undefined,
        reserved: true,
      }),
    );

    expect(html).toContain('w-fit opacity-0');
    expect(html).toContain('aria-hidden="true"');
    // 结构仍在 DOM（占位尺寸与落点一致），只是不可见
    expect(html).toContain('aria-label="查看 Appshot"');
  });

  it('is visible immediately once handed off (no fade transition)', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture,
        onRemove: () => undefined,
        reserved: false,
      }),
    );

    expect(html).not.toContain('w-fit opacity-0');
    // 根节点不带 aria-hidden（lucide 图标自身除外）
    expect(html.startsWith('<div class="relative group w-fit">')).toBe(true);
  });

  it('renders a single title line when windowTitle repeats the app name', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture: { ...capture, appName: 'ChatGPT', windowTitle: 'ChatGPT' },
        onRemove: () => undefined,
      }),
    );

    // 标题行只出现一次（避免 ChatGPT / ChatGPT 重复，app 名文字行省略）
    expect(html.match(/truncate max-w-\[13\.5rem\] text-xs text-zinc-200">ChatGPT/g)?.length).toBe(1);
  });

  it('falls back to app name in the title line when windowTitle is empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture: { ...capture, windowTitle: null },
        onRemove: () => undefined,
      }),
    );

    expect(html).toContain('truncate max-w-[13.5rem] text-xs text-zinc-200">TextEdit</span>');
  });

  it('renders the large thumbnail at the fly-in landing slot size', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppshotChip, {
        capture,
        onRemove: () => undefined,
      }),
    );

    // 缩略图矩形 = ComposerChipsRow 落点锚（left/bottom 9px, w-60 h-[7.5rem]）的尺寸
    expect(html).toContain('w-60 h-[7.5rem]');
  });
});
