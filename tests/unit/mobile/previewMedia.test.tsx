// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PreviewMedia } from '../../../packages/mobile/src/features/sessions/PreviewMedia';

describe('PreviewMedia', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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
  });

  it('text/* 仍走 <pre>，不为文本创建 object URL', () => {
    const create = vi.fn(() => 'blob:should-not');
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: () => {} });
    const { container } = render(
      <PreviewMedia name="note.txt" mimeType="text/plain" bytes={new TextEncoder().encode('hello')} />);
    expect(container.querySelector('pre')?.textContent).toBe('hello');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('不把 HTML 预览分支复活成可执行文档', () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:html', revokeObjectURL: () => {} });
    const { container } = render(
      <PreviewMedia name="page.html" mimeType="text/html" bytes={new TextEncoder().encode('<img src=x onerror=alert(1)>')} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
