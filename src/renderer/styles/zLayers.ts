// ============================================================================
// 全屏浮层 z-index 阶梯：fixed/absolute 顶层浮层（modal/drawer/toast/floater）
// 统一从这里取值，别再散落 z-[9999] 这类任意值 class。
//
// 用 style={{ zIndex }} 而不是 Tailwind 任意值 class（`z-[${Z.toast}]`）——
// Tailwind JIT 只扫源码里的静态字符串，运行时拼出来的类名扫不到会静默不生效。
// 这个坑 Modal.tsx 早就踩过一次坑并绕开了（zIndex 走 prop + style），本文件延续
// 同一套路，不引入 tailwind.config zIndex 主题键+安全清单这条平行路径。
//
// 层级关系照抄现状（改常量化不改语义）：memoFloater < drawer/undoToast <
// contextMenu/toast/voiceStatus。数值本身重新分配、留足档间距，原始
// 9999/9998/100 是历史随手写的魔法数字，不是有意设计的间距。
// ============================================================================

export const Z_LAYERS = {
  /** MemoFloater 全屏轻量浮层。现状明显低于 drawer/toast 档，未改语义。 */
  memoFloater: 1000,
  /** SidebarProjectDrawer 侧边抽屉。 */
  drawer: 1900,
  /** UndoToast 撤销提示条。现状与 drawer 同档（历史遗留，非刻意设计），保留。 */
  undoToast: 1900,
  /** SessionContextMenu 右键菜单。 */
  contextMenu: 2000,
  /** Toast 全局提示。 */
  toast: 2000,
  /** VoicePasteIndicator 语音状态指示器。 */
  voiceStatus: 2000,
} as const;
