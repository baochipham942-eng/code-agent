// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { runInAppInteractionStep } from '../../../src/renderer/utils/inAppValidationExecutor';

describe('inAppValidationExecutor unique-origin driver', () => {
  it('contentDocument 缺失时走 postMessage 驱动，不把跨源当成硬失败', async () => {
    const iframe = {
      contentDocument: null,
      contentWindow: {
        postMessage(payload: { type: string; id: string }) {
          window.dispatchEvent(new MessageEvent('message', {
            data: {
              type: 'neo-in-app-result',
              id: payload.id,
              result: {
                label: '点切换按钮',
                viewport: 'in-app',
                action: { type: 'click-selector', selector: '#toggle' },
                passed: true,
                durationMs: 1,
                failures: [],
                checks: ['clicked #toggle'],
              },
            },
          }));
        },
      },
    } as unknown as HTMLIFrameElement;

    const result = await runInAppInteractionStep(iframe, {
      label: '点切换按钮',
      action: { type: 'click-selector', selector: '#toggle' },
    });
    expect(result.passed).toBe(true);
    expect(result.checks).toContain('clicked #toggle');
  });
});
