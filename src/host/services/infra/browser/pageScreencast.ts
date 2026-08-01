import type { Page } from 'playwright';

// CDP Page.startScreencast 封装（B1-R·R1 图形化浏览器现场）。
//
// 实测（2026-08-01，系统 Chrome --headless=new + connectOverCDP，与托管浏览器默认
// provider 同路径）：jpeg q60 / maxWidth 960 / everyNthFrame 1 → 59.9 fps、首帧 19ms、
// 采集到收帧中位延迟 3ms、~409KB/s。everyNthFrame 2 → 30fps / 146KB/s。
//
// 两个必须知道的性质：
// 1. **不重绘就没有帧**。静态页开流后一帧都不会来，所以开流后补一次
//    Page.captureScreenshot 把首帧踢出来（实测静态页 kick 后恰好 1 帧，之后为 0，
//    正是想要的：静止时零开销）。
// 2. 帧必须 ack，否则 Chrome 只发一帧就停。

interface PageScreencastOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  everyNthFrame: number;
  /** 推给 renderer 的最小间隔，独立于 everyNthFrame——前者省浏览器编码，这条省 IPC 带宽 */
  minIntervalMs: number;
}

interface PageScreencastFrame {
  base64: string;
  width: number;
  height: number;
  capturedAtMs: number;
}

export interface PageScreencastHandle {
  stop(): Promise<void>;
}

export const DEFAULT_PAGE_SCREENCAST_OPTIONS: PageScreencastOptions = {
  maxWidth: 1024,
  maxHeight: 640,
  quality: 55,
  everyNthFrame: 2,
  minIntervalMs: 100,
};

export function clampScreencastBounds(
  maxWidth: number | undefined,
  maxHeight: number | undefined,
): { maxWidth: number; maxHeight: number } {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (!Number.isFinite(value) || !value) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  return {
    maxWidth: clamp(maxWidth, DEFAULT_PAGE_SCREENCAST_OPTIONS.maxWidth, 240, 1600),
    maxHeight: clamp(maxHeight, DEFAULT_PAGE_SCREENCAST_OPTIONS.maxHeight, 160, 1200),
  };
}

export async function startPageScreencast(
  page: Page,
  options: PageScreencastOptions,
  onFrame: (frame: PageScreencastFrame) => void,
): Promise<PageScreencastHandle> {
  const cdp = await page.context().newCDPSession(page);
  let lastEmittedAtMs = 0;
  let stopped = false;

  cdp.on('Page.screencastFrame', (payload: {
    data: string;
    sessionId: number;
    metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number };
  }) => {
    // ack 先发：不 ack Chrome 会停流，比丢一帧严重得多。
    void cdp.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => undefined);
    if (stopped) return;
    const now = Date.now();
    if (now - lastEmittedAtMs < options.minIntervalMs) return;
    lastEmittedAtMs = now;
    onFrame({
      base64: payload.data,
      width: Math.round(payload.metadata?.deviceWidth || options.maxWidth),
      height: Math.round(payload.metadata?.deviceHeight || options.maxHeight),
      capturedAtMs: now,
    });
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: options.quality,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    everyNthFrame: Math.max(1, options.everyNthFrame),
  });
  // 首帧踢一下——静态页不重绘就永远不发帧，用户会看到空白面板。
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: options.quality })
    .catch(() => undefined);

  return {
    async stop() {
      stopped = true;
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}
