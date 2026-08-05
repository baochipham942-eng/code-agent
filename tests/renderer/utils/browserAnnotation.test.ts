import { describe, expect, it } from 'vitest';
import {
  buildBrowserAnnotationCapture,
  buildBrowserAnnotationMessageText,
  buildBrowserAnnotationPinListText,
} from '../../../src/renderer/utils/browserAnnotation';

describe('browserAnnotation 附件构造（N3）', () => {
  const pins = [
    { id: 'p1', xPercent: 20, yPercent: 30, comment: '这是什么', index: 1 },
    { id: 'p2', xPercent: 60, yPercent: 55, comment: '改这里', index: 2 },
  ];

  it('把多个 pin 评论排成 pinN 列表文本', () => {
    expect(buildBrowserAnnotationPinListText(pins)).toBe(
      'pin1: 这是什么\npin2: 改这里',
    );
  });

  it('消息正文含页面信息 + pin 列表', () => {
    const text = buildBrowserAnnotationMessageText({
      pins,
      pageUrl: 'https://example.com/page',
      pageTitle: 'Example Domain',
    });
    expect(text).toContain('浏览器批注');
    expect(text).toContain('Example Domain');
    expect(text).toContain('https://example.com/page');
    expect(text).toContain('pin1: 这是什么');
    expect(text).toContain('pin2: 改这里');
  });

  it('构造 AppshotCapture：带截图 dataURL + pin 文本，复用 appshot 附件类型', () => {
    const capture = buildBrowserAnnotationCapture({
      pins,
      screenshotDataUrl: 'data:image/png;base64,abc',
      pageUrl: 'https://example.com/',
      pageTitle: 'Example',
      requestId: 'ann-1',
      capturedAtMs: 1_700_000_000_000,
    });
    expect(capture.requestId).toBe('ann-1');
    expect(capture.screenshotDataUrl).toBe('data:image/png;base64,abc');
    expect(capture.appName).toBe('example.com');
    expect(capture.windowTitle).toBe('Example');
    expect(capture.axText).toContain('pin1: 这是什么');
    expect(capture.axText).toContain('pin2: 改这里');
    expect(capture.textSource).toBe('ax');
    expect(capture.textReady).toBe(true);
  });
});
