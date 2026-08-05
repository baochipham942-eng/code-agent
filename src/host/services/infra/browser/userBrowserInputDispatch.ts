import type { Page } from 'playwright';
import type { UserBrowserInputPayload } from '../../../../shared/utils/userBrowserInputPayload';

function mouseButton(
  button: 'left' | 'right' | 'middle' | undefined,
): 'left' | 'right' | 'middle' {
  if (button === 'right') return 'right';
  if (button === 'middle') return 'middle';
  return 'left';
}

/**
 * 在已校验的 payload 上执行 Playwright 输入。禁止 CDP 任意方法直通。
 */
export async function dispatchUserBrowserInputOnPage(
  page: Page,
  payload: UserBrowserInputPayload,
): Promise<void> {
  switch (payload.kind) {
    case 'click': {
      await page.mouse.click(payload.x, payload.y, {
        button: mouseButton(payload.button),
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
    case 'drag': {
      const button = mouseButton(payload.button);
      await page.mouse.move(payload.fromX, payload.fromY);
      await page.mouse.down({ button });
      if (payload.path && payload.path.length > 0) {
        for (const point of payload.path) {
          await page.mouse.move(point.x, point.y);
        }
      } else {
        // 无路径时线性插值若干步，避免瞬间 teleport（滑块类控件需要中间点）
        const steps = 12;
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          await page.mouse.move(
            payload.fromX + (payload.toX - payload.fromX) * t,
            payload.fromY + (payload.toY - payload.fromY) * t,
          );
        }
      }
      await page.mouse.move(payload.toX, payload.toY);
      await page.mouse.up({ button });
      return;
    }
    default: {
      const _exhaustive: never = payload;
      throw new Error(`Unsupported user browser input: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
