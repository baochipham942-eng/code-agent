/** iPhone 完整弹出的惯例时长。插件不把 duration 传给 JS（capacitor-plugins#287）。 */
export const KEYBOARD_ANIMATION_MS = 250;
/** iOS 键盘曲线的业界近似。系统曲线是私有的，JS 拿不到。 */
export const KEYBOARD_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** QuickType / 候选条高度变化远小于整键盘，系统 duration 是 0。 */
const KEYBOARD_SNAP_PX = 80;

export function keyboardTransitionMs(fromPx: number, toPx: number): number {
  return Math.abs(toPx - fromPx) < KEYBOARD_SNAP_PX ? 0 : KEYBOARD_ANIMATION_MS;
}

/** 输入区用 transform 跟键盘；--keyboard-h 给会话底部让位（布局一次到位，不跟动画逐帧改 .app 高度）。 */
export function applyKeyboardInset(area: HTMLElement, fromPx: number, toPx: number): void {
  const next = Math.max(0, Math.round(toPx));
  const ms = keyboardTransitionMs(fromPx, next);
  area.style.transition = ms === 0 ? 'none' : `transform ${ms}ms ${KEYBOARD_EASING}`;
  area.style.transform = next === 0 ? 'none' : `translate3d(0, -${next}px, 0)`;
  area.toggleAttribute('data-keyboard-inset', next > 0);
  area.closest<HTMLElement>('.conversation')?.style.setProperty('--keyboard-h', `${next}px`);
}
