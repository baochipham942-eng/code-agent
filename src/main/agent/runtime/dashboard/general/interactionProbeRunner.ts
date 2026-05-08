/**
 * Interaction probe runtime — Phase 4 Dashboard PR-E.
 *
 * 真跑 launch + click + MutationObserver 的实现。从 interactionProbes.ts
 * 拆出来的目的是：让 STATE_CHANGE_ON_CLICK_PROBE.evaluate 通过 import
 * 间接调用，单元测试 vi.mock('./interactionProbeRunner') 才能替换实现
 * （ES module 闭包绑定不允许替换同文件内部 reference）。
 *
 * 详细 anti-Potemkin 设计 / 五个 mode 解释见 interactionProbes.ts 顶部
 * doc comment。
 */

import { pathToFileURL } from 'url';

const NAVIGATE_TIMEOUT_MS = 10000;
const MUTATION_WAIT_MS = 100;
const VIEWPORT = { width: 1280, height: 720 } as const;

/** 内部 helper 的结构化 result — 五个 mode */
export interface StateChangeProbeResult {
  mode: 'pass' | 'no-target' | 'no-mutation' | 'handler-error' | 'launch-error';
  /** 选中的 selector（pass / no-mutation / handler-error 时有）*/
  selector?: string;
  /** 100ms 内捕获到的 meaningful mutation 数量 */
  mutations?: number;
  /** handler-error / launch-error 的错误消息 */
  errorMessage?: string;
}

export async function runStateChangeProbe(filePath: string): Promise<StateChangeProbeResult> {
  let browser: import('playwright').Browser | null = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(pathToFileURL(filePath).href, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    });

    // Plan §6 风险 3：第一波只用 <button> 和 <a[href]>，不试更宽的
    // [role="button"] / div onclick — 减少 false-positive 选错目标。
    const targetSelector = await page.evaluate(() => {
      const candidates: readonly string[] = ['button', 'a[href]'];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) return sel;
      }
      return null;
    });

    if (!targetSelector) {
      return { mode: 'no-target' };
    }

    // 在 page-side 同步注册 MutationObserver + 捕获 handler error，然后
    // click 触发，等 MUTATION_WAIT_MS 收 mutation。
    const result = await page.evaluate(
      ({ sel, waitMs }) => {
        return new Promise<{ mutations: number; handlerError?: string }>((resolve) => {
          const target = document.querySelector(sel);
          if (!target) {
            resolve({ mutations: 0 });
            return;
          }

          let mutationCount = 0;
          const observer = new MutationObserver((records) => {
            for (const r of records) {
              // Plan §6 风险 4：忽略 class / style / data-* / aria-* 属性
              // 变化 — :focus / :active / hover 衍生的伪 mutation 不算
              // "meaningful state change"。
              if (r.type === 'attributes') {
                const name = r.attributeName ?? '';
                if (
                  name === 'class' ||
                  name === 'style' ||
                  name.startsWith('data-') ||
                  name.startsWith('aria-')
                ) {
                  continue;
                }
              }
              mutationCount += 1;
            }
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });

          const handlerErrors: string[] = [];
          const previousOnError = window.onerror;
          window.onerror = (msg) => {
            handlerErrors.push(typeof msg === 'string' ? msg : String(msg));
            return true;
          };

          // 同步 click。target.click() 触发 listener；同步 throw 走 catch，
          // 异步 throw 走 window.onerror。
          try {
            (target as HTMLElement).click();
          } catch (err) {
            handlerErrors.push(err instanceof Error ? err.message : String(err));
          }

          window.setTimeout(() => {
            observer.disconnect();
            window.onerror = previousOnError;
            resolve({
              mutations: mutationCount,
              handlerError: handlerErrors[0],
            });
          }, waitMs);
        });
      },
      { sel: targetSelector, waitMs: MUTATION_WAIT_MS },
    );

    if (result.handlerError) {
      return {
        mode: 'handler-error',
        selector: targetSelector,
        errorMessage: result.handlerError,
      };
    }

    if (result.mutations === 0) {
      return {
        mode: 'no-mutation',
        selector: targetSelector,
        mutations: 0,
      };
    }

    return {
      mode: 'pass',
      selector: targetSelector,
      mutations: result.mutations,
    };
  } catch (err) {
    return {
      mode: 'launch-error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
