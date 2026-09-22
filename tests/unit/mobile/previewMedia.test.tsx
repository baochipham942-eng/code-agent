// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PreviewMedia } from '../../../packages/mobile/src/features/sessions/PreviewMedia';
import { canInlinePdf } from '../../../packages/mobile/src/platform/previewCapabilities';
import { messages } from '../../../packages/mobile/src/i18n';

const platform = { name: 'web' };

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const zh = messages('zh');
const en = messages('en');

function stubUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
}

describe('canInlinePdf', () => {
  it('Capacitor iOS 内联，Android 不内联；web 看 UA', () => {
    expect(canInlinePdf('ios', 'Mozilla/5.0 (Linux; Android 14)')).toBe(true);
    expect(canInlinePdf('android', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(false);
    expect(canInlinePdf('web', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(canInlinePdf('web', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0')).toBe(false);
    expect(canInlinePdf('web', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
  });
});

describe('PreviewMedia', () => {
  afterEach(() => {
    cleanup();
    platform.name = 'web';
    vi.unstubAllGlobals();
  });

  function bindPlatform() {
    vi.stubGlobal('Capacitor', { getPlatform: () => platform.name });
  }

  it('video/* 走 <video controls>，卸载时 revoke object URL', () => {
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:video-preview',
      revokeObjectURL: (url: string) => { revoked.push(url); },
    });
    const { unmount, container } = render(
      <PreviewMedia name="clip.mp4" mimeType="video/mp4" bytes={new Uint8Array([1, 2, 3])} />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('controls')).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:video-preview');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    unmount();
    expect(revoked).toEqual(['blob:video-preview']);
  });

  it('image/* 仍走 <img>，不误入 video 分支', () => {
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:image-preview',
      revokeObjectURL: () => {},
    });
    const { container } = render(
      <PreviewMedia name="shot.png" mimeType="image/png" bytes={new Uint8Array([9, 9])} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:image-preview');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.preview-fallback')).toBeNull();
  });

  it('text/* 仍走 <pre>，不为文本创建 object URL', () => {
    const create = vi.fn(() => 'blob:should-not');
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: () => {} });
    const { container } = render(
      <PreviewMedia name="note.txt" mimeType="text/plain" bytes={new TextEncoder().encode('hello')} />);
    expect(container.querySelector('pre')?.textContent).toBe('hello');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('不把 HTML 预览分支复活成可执行文档', () => {
    platform.name = 'ios';
    bindPlatform();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:html', revokeObjectURL: () => {} });
    const { container } = render(
      <PreviewMedia name="page.html" mimeType="text/html" bytes={new TextEncoder().encode('<img src=x onerror=alert(1)>')} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('embed')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('application/pdf 在 iOS 判定下走 blob iframe 内联，卸载时 revoke', () => {
    platform.name = 'ios';
    bindPlatform();
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:pdf-preview',
      revokeObjectURL: (url: string) => { revoked.push(url); },
    });
    const { unmount, container } = render(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={zh} />);
    const frame = container.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('src')).toBe('blob:pdf-preview');
    expect(frame?.getAttribute('title')).toBe('spec.pdf');
    expect(container.querySelector('.preview-fallback')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    unmount();
    expect(revoked).toEqual(['blob:pdf-preview']);
  });

  it('application/pdf 在 Android 判定下走降级卡，不创建 object URL', () => {
    platform.name = 'android';
    bindPlatform();
    const create = vi.fn(() => 'blob:should-not');
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: () => {} });
    const { container } = render(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={zh} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('embed')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('.preview-fallback')?.textContent).toContain(zh.pdfInlineUnavailable);
    expect(create).not.toHaveBeenCalled();
  });

  it('web + Android UA 走降级卡；web + iPhone UA 走内联', () => {
    platform.name = 'web';
    bindPlatform();
    stubUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0');
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:pdf-preview', revokeObjectURL: () => {} });
    const android = render(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={zh} />);
    expect(android.container.querySelector('iframe')).toBeNull();
    expect(android.container.querySelector('.preview-fallback')).toBeTruthy();
    android.unmount();

    stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    const iosWeb = render(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={zh} />);
    expect(iosWeb.container.querySelector('iframe')?.getAttribute('src')).toBe('blob:pdf-preview');
    expect(iosWeb.container.querySelector('.preview-fallback')).toBeNull();
    iosWeb.unmount();
  });

  it('降级卡保存按钮调既有保存路径，中英文案来自 i18n', () => {
    platform.name = 'android';
    bindPlatform();
    const onSave = vi.fn();
    const { container, rerender } = render(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={zh} onSave={onSave} />);
    const button = container.querySelector('button.primary');
    expect(button?.textContent).toBe(zh.pdfOpenExternally);
    fireEvent.click(button!);
    expect(onSave).toHaveBeenCalledTimes(1);
    rerender(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={en} onSave={onSave} />);
    expect(container.querySelector('.preview-fallback')?.textContent).toContain(en.pdfInlineUnavailable);
    expect(container.querySelector('button.primary')?.textContent).toBe(en.pdfOpenExternally);
  });

  it('降级卡不自带成功文案；不传 onSave 时仍说明原因且不阻断外层保存', () => {
    platform.name = 'android';
    bindPlatform();
    const { container } = render(
      <PreviewMedia name="spec.pdf" mimeType="application/pdf" bytes={pdfBytes} text={zh} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain(zh.pdfInlineUnavailable);
    expect(container.textContent).not.toContain(zh.savedToDevice);
  });
});
