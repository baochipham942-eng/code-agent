// ============================================================================
// 无渲染进程时 validate_html_in_app 必须立刻失败，不能等到超时
// ============================================================================
// 无头跑法（评测 CLI / 脚本）里没人收 IN_APP_VALIDATION_REQUEST，旧行为是干等
// DEFAULT_IN_APP_VALIDATION_TIMEOUT_MS（30s）——那 30s 会被算进题的时间预算，
// 把「环境缺渲染进程」混进能力评测。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IN_APP_VALIDATION_UNAVAILABLE,
  getPendingInAppValidationCount,
  handleInAppValidationResult,
  runInAppValidation,
} from '../../../src/host/services/inAppValidationService';
import { onRendererPush } from '../../../src/host/platform/windowBridge';
import { executeValidateHtmlInApp } from '../../../src/host/plugins/builtin/browserControl/validateHtmlInApp';

const STEPS = [{ action: { type: 'click-selector' as const, selector: '#b' } }];
const HTML = '<html><body><button id="b">go</button></body></html>';

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});

describe('runInAppValidation without a renderer', () => {
  it('立刻 reject，不等超时，错误文案固定', async () => {
    const started = Date.now();
    // 超时给 30s：真等下去这条断言会跑满 30s，快速失败才可能在 1s 内回来
    await expect(runInAppValidation(HTML, STEPS, 30_000)).rejects.toThrow(IN_APP_VALIDATION_UNAVAILABLE);
    expect(Date.now() - started).toBeLessThan(1000);
    // 没进 pending 表 ⇒ 没留下会在 30s 后触发的定时器
    expect(getPendingInAppValidationCount()).toBe(0);
  });

  it('工具壳把它归成 PANEL_UNAVAILABLE，与「验证跑了但没过」区分开', async () => {
    const result = await executeValidateHtmlInApp(
      { html: HTML, steps: STEPS },
      { sessionId: 'test', abortSignal: new AbortController().signal } as never,
      (async () => ({ allow: true })) as never,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PANEL_UNAVAILABLE');
    expect(result.error).toBe(IN_APP_VALIDATION_UNAVAILABLE);
  });

  it('有渲染进程在收时不快速失败——照常等回传', async () => {
    // 反证：快速失败不是「永远失败」。挂上一个订阅者（SSE 层就是这么订的）之后，
    // 请求必须真的发出去并挂起，等 handleInAppValidationResult 交付。
    const seen: Array<{ requestId: string }> = [];
    disposers.push(onRendererPush((_channel, data) => { seen.push(data as { requestId: string }); }));

    const pending = runInAppValidation(HTML, STEPS, 30_000);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(getPendingInAppValidationCount()).toBe(1);

    handleInAppValidationResult({
      requestId: seen[0].requestId,
      results: [{
        action: STEPS[0].action, label: 'click', passed: true,
        checks: ['clicked'], failures: [], durationMs: 1,
      }],
    } as never);

    await expect(pending).resolves.toHaveLength(1);
    expect(getPendingInAppValidationCount()).toBe(0);
  });
});
