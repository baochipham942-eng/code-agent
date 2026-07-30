// ============================================================================
// libraryPinEvents - pin 变更跨组件通知（@ 面板资料库组 ↔ Composer pinned chips）
// ============================================================================
//
// pin 写库成功后广播，composer 上方的 pinned chips 行监听后重新拉取，
// 保证「勾选 → 输入框上方立即看到 chip」闭环。

export const LIBRARY_PIN_CHANGED_EVENT = 'app:libraryPinChanged';

export function notifyLibraryPinChanged(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(LIBRARY_PIN_CHANGED_EVENT, { detail: sessionId }));
}
