import type { Page } from 'playwright';
import type { UserBrowserInputPayload } from '../../../../shared/utils/userBrowserInputPayload';

/**
 * 在已校验的 payload 上执行 Playwright 输入。禁止 CDP 任意方法直通。
 */
export async function dispatchUserBrowserInputOnPage(
  page: Page,
  payload: UserBrowserInputPayload,
): Promise<void> {
  switch (payload.kind) {
    case 'click': {
      const button = payload.button === 'right'
        ? 'right'
        : payload.button === 'middle'
          ? 'middle'
          : 'left';
      await page.mouse.click(payload.x, payload.y, {
        button,
        clickCount: payload.clickCount ?? 1,
      });
      return;
    }
    case 'wheel': {
      if (typeof payload.x === 'number' && typeof payload.y === 'number') {
        await page.mouse.move(payload.x, payload.y);
      }
      await page.mouse.wheel(payload.deltaX, payload.deltaY);
      return;
    }
    case 'key': {
      const mods = payload.modifiers;
      const chord: string[] = [];
      if (mods?.ctrl) chord.push('Control');
      if (mods?.meta) chord.push('Meta');
      if (mods?.alt) chord.push('Alt');
      if (mods?.shift) chord.push('Shift');
      const key = payload.key === ' ' ? 'Space' : payload.key;
      const pressTarget = chord.length > 0 ? `${chord.join('+')}+${key}` : key;
      await page.keyboard.press(pressTarget);
      return;
    }
    case 'insertText': {
      await page.keyboard.insertText(payload.text);
      return;
    }
    default: {
      const _exhaustive: never = payload;
      throw new Error(`Unsupported user browser input: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
