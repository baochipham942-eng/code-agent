// button_no_response 点击探针 — N-ORPHAN-WIRE-DASHBOARD-VALIDATOR。
//
// anti-Potemkin：viewport 循环只读不点；这里回到第一个 viewport、重载页面拿干净
// 状态，点击第一个可见且启用的 <button> 一次（绝不点 <a>，导航副作用不可控）。
// 响应判据 = settle 窗口内有 meaningful DOM mutation（忽略 class/style/data-*/
// aria-* 属性变化）或点击后 document.body.innerText 有差异（纯 class 切换的 tab
// 靠可见性变化走这条臂）。探针自身异常 => warn 带可区分原因、返回 undefined，
// 不发 finding（fail-open 但不静默）。

import type { Page } from 'playwright';
import { ARTIFACT_PREVIEW_HEALTH } from '../../../../shared/constants/previewHealth';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('ArtifactPreviewHealth', { lane: 'browser' });

export interface ArtifactPreviewHealthButtonClickDiagnostics {
  /** false = 页面没有可见且启用的 <button>（不是缺陷）；探针异常时整个字段缺省。 */
  checked: boolean;
  responded?: boolean;
  mutations?: number;
  textChanged?: boolean;
  clickError?: string;
}

export async function probeArtifactButtonClick(args: {
  page: Page;
  url: string;
  viewport: { name: string; width: number; height: number };
  remainingMs: () => number;
}): Promise<ArtifactPreviewHealthButtonClickDiagnostics | undefined> {
  const { page, url, viewport, remainingMs } = args;
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: remainingMs(),
    });
    await page.waitForTimeout(ARTIFACT_PREVIEW_HEALTH.SETTLE_MS);
    return await page.evaluate(({ settleMs, minVisibleSize }) => {
      // 注意：这个回调会被整体序列化进页面执行，函数体里不许出现「具名函数绑定」——
      // tsx/esbuild keepNames 会给它包 __name(...)，序列化后在页面上下文里是未定义
      // （实机踩坑 ReferenceError: __name is not defined）。可见性判据因此保持内联
      // 箭头（与 artifactPreviewHealthProbe 的 viewport 探针同构），不抽共享 helper。
      const visibleEnabledButtons = [...document.querySelectorAll('button')].filter((element) => {
        if (element.disabled) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > minVisibleSize
          && rect.height > minVisibleSize
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number(style.opacity || '1') !== 0
          && rect.bottom >= 0
          && rect.right >= 0
          && rect.top <= window.innerHeight
          && rect.left <= window.innerWidth;
      });
      if (visibleEnabledButtons.length === 0) {
        return { checked: false };
      }

      const target = visibleEnabledButtons[0];
      const textBefore = document.body?.innerText ?? '';
      let mutations = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          // class/style/data-*/aria-* 属性变化是 :focus/:active/hover 衍生的伪
          // mutation，不算 meaningful state change。
          if (record.type === 'attributes') {
            const name = record.attributeName ?? '';
            if (
              name === 'class'
              || name === 'style'
              || name.startsWith('data-')
              || name.startsWith('aria-')
            ) {
              continue;
            }
          }
          mutations += 1;
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      let clickError: string | undefined;
      try {
        target.click();
      } catch (error) {
        clickError = error instanceof Error ? error.message : String(error);
      }

      return new Promise<ArtifactPreviewHealthButtonClickDiagnostics>((resolve) => {
        window.setTimeout(() => {
          observer.disconnect();
          const textAfter = document.body?.innerText ?? '';
          const textChanged = textBefore !== textAfter;
          resolve({
            checked: true,
            responded: mutations > 0 || textChanged,
            mutations,
            textChanged,
            ...(clickError ? { clickError } : {}),
          });
        }, settleMs);
      });
    }, {
      settleMs: ARTIFACT_PREVIEW_HEALTH.BUTTON_CLICK_SETTLE_MS,
      minVisibleSize: ARTIFACT_PREVIEW_HEALTH.VISIBLE_ELEMENT_MIN_SIZE_PX,
    });
  } catch (error) {
    logger.warn('Artifact preview health button click probe failed; check skipped (fail-open)', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
