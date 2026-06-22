// ============================================================================
// pdfExport - 设计模式 PDF 导出服务（CD-Parity §2）
// 覆盖：imageToPdf 真 pdfkit 产物头校验（%PDF）；htmlToPdf 经 mock 走 ok 路 + !ok 抛可读错误
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// playwrightRuntime 被 mock：ok 路返回伪 chromium（launch→newPage→pdf→close），
// !ok 路返回不可用，断言 htmlToPdf 抛出包含可读前缀的错误。绝不真启 chromium。
const loadPlaywrightChromiumMock = vi.fn();
vi.mock('../../../../src/main/runtime/playwrightRuntime', () => ({
  loadPlaywrightChromium: (...args: unknown[]) => loadPlaywrightChromiumMock(...args),
}));

import { htmlToPdf, imageToPdf } from '../../../../src/main/services/design/pdfExport';

afterEach(() => {
  vi.clearAllMocks();
});

describe('imageToPdf', () => {
  it('embeds a PNG into a single-page PDF whose bytes start with %PDF', async () => {
    const png = await sharp({
      create: { width: 8, height: 6, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const pdf = await imageToPdf(png);

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('throws when image dimensions cannot be read', async () => {
    await expect(imageToPdf(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('htmlToPdf', () => {
  it('renders via playwright page.pdf when chromium is available', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake');
    const close = vi.fn().mockResolvedValue(undefined);
    const pdf = vi.fn().mockResolvedValue(fakePdf);
    const setContent = vi.fn().mockResolvedValue(undefined);
    const newPage = vi.fn().mockResolvedValue({ setContent, pdf });
    const launch = vi.fn().mockResolvedValue({ newPage, close });
    loadPlaywrightChromiumMock.mockResolvedValue({ ok: true, chromium: { launch } });

    const result = await htmlToPdf('<html><body>hi</body></html>');

    expect(launch).toHaveBeenCalledWith({ headless: true });
    expect(setContent).toHaveBeenCalledWith('<html><body>hi</body></html>', { waitUntil: 'load' });
    expect(pdf).toHaveBeenCalledWith({ printBackground: true, preferCSSPageSize: true });
    expect(close).toHaveBeenCalled();
    expect(result.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('closes the browser even if page.pdf throws', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const newPage = vi.fn().mockResolvedValue({
      setContent: vi.fn().mockResolvedValue(undefined),
      pdf: vi.fn().mockRejectedValue(new Error('render boom')),
    });
    const launch = vi.fn().mockResolvedValue({ newPage, close });
    loadPlaywrightChromiumMock.mockResolvedValue({ ok: true, chromium: { launch } });

    await expect(htmlToPdf('<html></html>')).rejects.toThrow('render boom');
    expect(close).toHaveBeenCalled();
  });

  it('throws a readable error when chromium is unavailable (no crash)', async () => {
    loadPlaywrightChromiumMock.mockResolvedValue({
      ok: false,
      error: 'Playwright package is unavailable in this runtime',
      missingPackage: true,
    });

    await expect(htmlToPdf('<html></html>')).rejects.toThrow(/PDF 导出需要 Playwright Chromium/);
    await expect(htmlToPdf('<html></html>')).rejects.toThrow(/Playwright package is unavailable/);
  });
});
