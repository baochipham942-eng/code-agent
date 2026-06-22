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

// htmlToPdf 现走 browser.newContext({javaScriptEnabled:false}).newPage() + page.route 拦截
// （FIX 7 安全隔离）。该 helper 构造对应 mock 链，返回各 spy 便于断言。
function makeChromiumMock(opts?: { pdf?: ReturnType<typeof vi.fn> }) {
  const close = vi.fn().mockResolvedValue(undefined);
  const pdf = opts?.pdf ?? vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
  const setContent = vi.fn().mockResolvedValue(undefined);
  let routeHandler: ((r: unknown) => void) | undefined;
  const route = vi.fn().mockImplementation((_pattern: string, h: (r: unknown) => void) => {
    routeHandler = h;
    return Promise.resolve();
  });
  const page = { setContent, pdf, route };
  const newPage = vi.fn().mockResolvedValue(page);
  const newContext = vi.fn().mockResolvedValue({ newPage });
  const launch = vi.fn().mockResolvedValue({ newContext, close });
  return { close, pdf, setContent, route, newPage, newContext, launch, getRouteHandler: () => routeHandler };
}

describe('htmlToPdf', () => {
  it('renders via playwright page.pdf with JS disabled + request blocking', async () => {
    const m = makeChromiumMock();
    loadPlaywrightChromiumMock.mockResolvedValue({ ok: true, chromium: { launch: m.launch } });

    const result = await htmlToPdf('<html><body>hi</body></html>');

    expect(m.launch).toHaveBeenCalledWith({ headless: true });
    // FIX 7：静态打印禁 JS（无需运行原型脚本）
    expect(m.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ javaScriptEnabled: false }),
    );
    // FIX 7：setContent 之前注册 route 拦截器
    expect(m.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(m.route.mock.invocationCallOrder[0]).toBeLessThan(
      m.setContent.mock.invocationCallOrder[0],
    );
    expect(m.setContent).toHaveBeenCalledWith('<html><body>hi</body></html>', {
      waitUntil: 'load',
    });
    expect(m.pdf).toHaveBeenCalledWith({ printBackground: true, preferCSSPageSize: true });
    expect(m.close).toHaveBeenCalled();
    expect(result.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('FIX 7: route handler aborts external urls, allows data:/about:', async () => {
    const m = makeChromiumMock();
    loadPlaywrightChromiumMock.mockResolvedValue({ ok: true, chromium: { launch: m.launch } });

    await htmlToPdf('<html></html>');
    const routeHandler = m.getRouteHandler();
    expect(routeHandler).toBeTypeOf('function');

    const mkRoute = (url: string) => ({
      request: () => ({ url: () => url }),
      continue: vi.fn(),
      abort: vi.fn(),
    });

    const ext = mkRoute('https://evil.example.com/exfil?x=1');
    routeHandler!(ext);
    expect(ext.abort).toHaveBeenCalled();
    expect(ext.continue).not.toHaveBeenCalled();

    const data = mkRoute('data:image/png;base64,AAAA');
    routeHandler!(data);
    expect(data.continue).toHaveBeenCalled();
    expect(data.abort).not.toHaveBeenCalled();

    const about = mkRoute('about:blank');
    routeHandler!(about);
    expect(about.continue).toHaveBeenCalled();
  });

  it('closes the browser even if page.pdf throws', async () => {
    const m = makeChromiumMock({ pdf: vi.fn().mockRejectedValue(new Error('render boom')) });
    loadPlaywrightChromiumMock.mockResolvedValue({ ok: true, chromium: { launch: m.launch } });

    await expect(htmlToPdf('<html></html>')).rejects.toThrow('render boom');
    expect(m.close).toHaveBeenCalled();
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
