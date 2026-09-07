// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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

  it('驱动超时覆盖 wait.ms 与 expect.timeoutMs，不会把 10s wait 截在 8s', async () => {
    vi.useFakeTimers();
    const iframe = {
      contentDocument: null,
      contentWindow: { postMessage() { /* no driver result */ } },
    } as unknown as HTMLIFrameElement;
    try {
      const waitP = runInAppInteractionStep(iframe, {
        label: 'wait',
        action: { type: 'wait', ms: 10_000 },
      });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await Promise.race([waitP.then(() => 'done'), Promise.resolve('pending')])).toBe('pending');
      await vi.advanceTimersByTimeAsync(5_000);
      const waitResult = await waitP;
      expect(waitResult.failures.some((line) => line.includes('timed out'))).toBe(true);

      const serialP = runInAppInteractionStep(iframe, {
        label: 'serial',
        action: { type: 'click-selector', selector: '#a' },
        expect: { textVisible: 'ok', selectorVisible: '#b', timeoutMs: 5000 },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await Promise.race([serialP.then(() => 'done'), Promise.resolve('pending')])).toBe('pending');
      await vi.advanceTimersByTimeAsync(3_000);
      const serial = await serialP;
      expect(serial.failures.some((line) => line.includes('timed out'))).toBe(true);

      const zeroP = runInAppInteractionStep(iframe, {
        label: 'zero',
        action: { type: 'click-selector', selector: '#a' },
        expect: { textVisible: 'ok', timeoutMs: 0 },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const zero = await zeroP;
      expect(zero.failures.some((line) => line.includes('timed out'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
