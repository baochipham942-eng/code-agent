// 浏览器批注（二期 N3）：pin + 评论 → 复用 appshot 附件链路的构造器。
// 纯函数，便于单测与变异验证；UI 只负责采集坐标/截图并调用这里。

import type { AppshotCapture } from '@shared/contract/appshot';

export interface BrowserAnnotationPin {
  id: string;
  /** 相对页面画面的百分比坐标 0–100 */
  xPercent: number;
  yPercent: number;
  comment: string;
  /** 1-based 显示编号 */
  index: number;
}

export interface BuildBrowserAnnotationCaptureInput {
  pins: BrowserAnnotationPin[];
  screenshotDataUrl: string;
  pageUrl: string | null;
  pageTitle: string | null;
  requestId?: string;
  capturedAtMs?: number;
}

export function buildBrowserAnnotationPinListText(pins: BrowserAnnotationPin[]): string {
  return pins
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((pin) => `pin${pin.index}: ${pin.comment.trim() || '(无评论)'}`)
    .join('\n');
}

export function buildBrowserAnnotationMessageText(input: {
  pins: BrowserAnnotationPin[];
  pageUrl: string | null;
  pageTitle: string | null;
}): string {
  const headerParts = [
    '浏览器批注',
    input.pageTitle?.trim() || null,
    input.pageUrl?.trim() || null,
  ].filter(Boolean);
  const list = buildBrowserAnnotationPinListText(input.pins);
  return `${headerParts.join(' · ')}\n\n${list}`.trim();
}

/** 把带 pin 标记的截图 + 评论文本打成 AppshotCapture，走现有 AppshotChip / 附件卡。 */
export function buildBrowserAnnotationCapture(
  input: BuildBrowserAnnotationCaptureInput,
): AppshotCapture {
  const requestId = input.requestId
    || `browser-annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const pinText = buildBrowserAnnotationPinListText(input.pins);
  const host = (() => {
    if (!input.pageUrl) return 'Browser';
    try {
      return new URL(input.pageUrl).hostname || 'Browser';
    } catch {
      return 'Browser';
    }
  })();
  return {
    requestId,
    appName: host,
    windowTitle: input.pageTitle || input.pageUrl || 'Browser annotation',
    screenshotPath: '',
    screenshotDataUrl: input.screenshotDataUrl,
    axText: pinText,
    textSource: pinText.trim() ? 'ax' : 'none',
    textReady: true,
    windowFrame: { x: 0, y: 0, width: 0, height: 0 },
    capturedAtMs: input.capturedAtMs ?? Date.now(),
  };
}

/**
 * 在已有页面截图 dataURL 上叠加编号 pin 圆点，返回新的 PNG dataURL。
 * 无 document/canvas 环境（单测）时原样返回源图。
 */
export async function stampPinsOnScreenshot(
  screenshotDataUrl: string,
  pins: BrowserAnnotationPin[],
): Promise<string> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return screenshotDataUrl;
  }
  const image = new Image();
  image.src = screenshotDataUrl;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to load screenshot for annotation stamp.'));
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width <= 0 || canvas.height <= 0) return screenshotDataUrl;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const pin of pins) {
    const x = (pin.xPercent / 100) * canvas.width;
    const y = (pin.yPercent / 100) * canvas.height;
    const radius = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) * 0.018));
    ctx.beginPath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = Math.max(2, Math.round(radius * 0.2));
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(11, Math.round(radius * 1.1))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(pin.index), x, y + 0.5);
  }

  return canvas.toDataURL('image/png');
}
