// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { KEYBOARD_ANIMATION_MS, applyKeyboardInset, keyboardTransitionMs } from '../../../packages/mobile/src/app/keyboardInset';

afterEach(() => {
  document.documentElement.style.removeProperty('--keyboard-h');
  document.documentElement.style.removeProperty('--keyboard-duration');
  document.documentElement.style.removeProperty('--keyboard-easing');
  document.documentElement.removeAttribute('data-keyboard-inset');
});

describe('keyboardTransitionMs', () => {
  it('完整弹出用 250ms，QuickType 那种小高度差关掉过渡', () => {
    expect(keyboardTransitionMs(0, 336)).toBe(KEYBOARD_ANIMATION_MS);
    expect(keyboardTransitionMs(336, 0)).toBe(KEYBOARD_ANIMATION_MS);
    expect(keyboardTransitionMs(336, 370)).toBe(0);
    expect(keyboardTransitionMs(370, 336)).toBe(0);
  });
});

describe('applyKeyboardInset', () => {
  it('把 transform 写在输入区、把 --keyboard-h 写在 :root（sheet 和会话底部一起让位）', () => {
    const root = document.createElement('div');
    root.className = 'conversation';
    const area = document.createElement('div');
    area.className = 'composer-area';
    root.append(area);
    document.body.append(root);

    applyKeyboardInset(area, 0, 336);
    expect(area.style.transform).toBe('translate3d(0, -336px, 0)');
    expect(area.style.transition).toContain(`${KEYBOARD_ANIMATION_MS}ms`);
    expect(area.hasAttribute('data-keyboard-inset')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--keyboard-duration')).toBe(`${KEYBOARD_ANIMATION_MS}ms`);
    expect(document.documentElement.style.getPropertyValue('--keyboard-h')).toBe('336px');
    expect(document.documentElement.hasAttribute('data-keyboard-inset')).toBe(true);

    applyKeyboardInset(area, 336, 370);
    expect(area.style.transition).toBe('none');
    expect(area.style.transform).toBe('translate3d(0, -370px, 0)');

    applyKeyboardInset(area, 370, 0);
    expect(area.style.transform).toBe('none');
    expect(area.hasAttribute('data-keyboard-inset')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--keyboard-h')).toBe('0px');
    expect(document.documentElement.hasAttribute('data-keyboard-inset')).toBe(false);
  });
});
