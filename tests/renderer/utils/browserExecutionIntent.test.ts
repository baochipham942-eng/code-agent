import { describe, expect, it } from 'vitest';
import { buildBrowserSessionIntentSnapshot } from '../../../src/renderer/utils/browserExecutionIntent';

describe('buildBrowserSessionIntentSnapshot', () => {
  it('projects managed browser preview into execution intent snapshot', () => {
    expect(buildBrowserSessionIntentSnapshot({
      mode: 'managed',
      browserSession: {
        preview: {
          mode: 'managed',
          title: 'Docs · Example',
          url: 'https://example.com/docs',
          surfaceMode: 'headless',
          traceId: 'trace-1',
        },
        blocked: false,
        blockedDetail: undefined,
        blockedHint: undefined,
      },
    })).toEqual({
      ready: true,
      preview: {
        title: 'Docs · Example',
        url: 'https://example.com/docs',
        surfaceMode: 'headless',
        traceId: 'trace-1',
      },
    });
  });

  it('projects blocked desktop context into execution intent snapshot', () => {
    expect(buildBrowserSessionIntentSnapshot({
      mode: 'desktop',
      browserSession: {
        preview: {
          mode: 'desktop',
          title: 'ChatGPT',
          url: 'https://chatgpt.com',
          frontmostApp: 'Google Chrome',
          lastScreenshotAtMs: Date.UTC(2026, 3, 17, 8, 30, 0),
        },
        blocked: true,
        blockedDetail: '当前桌面浏览器上下文未就绪：屏幕录制未授权、collector 未启动。',
        blockedHint: '先补权限并启动采集。',
      },
    })).toEqual({
      ready: false,
      blockedDetail: '当前桌面浏览器上下文未就绪：屏幕录制未授权、collector 未启动。',
      blockedHint: '先补权限并启动采集。',
      preview: {
        title: 'ChatGPT',
        url: 'https://chatgpt.com',
        frontmostApp: 'Google Chrome',
        lastScreenshotAtMs: Date.UTC(2026, 3, 17, 8, 30, 0),
      },
    });
  });
});
