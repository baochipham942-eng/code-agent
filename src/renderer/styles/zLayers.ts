// ============================================================================
// 全屏浮层 z-index 阶梯：fixed/absolute 顶层浮层（modal/drawer/toast/floater）
// 统一从这里取值，别再散落 Tailwind 任意值 z-index class（check-design-system.mjs
// 的 bare-z-index 规则按字面正则匹配代码模式，连注释里的示例数字都会命中——
// 这行本身改过一次措辞，别再往这写具体的 z-[数字] 例子）。
//
// 用 style={{ zIndex }} 而不是 Tailwind 任意值 class（`z-[${Z.toast}]`）——
// Tailwind JIT 只扫源码里的静态字符串，运行时拼出来的类名扫不到会静默不生效。
// 这个坑 Modal.tsx 早就踩过一次坑并绕开了（zIndex 走 prop + style），本文件延续
// 同一套路，不引入 tailwind.config zIndex 主题键+安全清单这条平行路径。
//
// 层级关系照抄现状（改常量化不改语义）：modal < devServerModal <
// forceUpdateModal < memoFloater < drawer/undoToast < contextMenu/toast/
// voiceStatus/statusPopover < criticalOverlay。数值本身重新分配、留足档间距，
// 原始 9999/9998/100 是历史随手写的魔法数字，不是有意设计的间距。
//
// modal/devServerModal/forceUpdateModal 三档是 primitives/Modal.tsx 家族
// （常规居中弹窗），与 memoFloater 起的浮层家族是两套独立层级——两家历史上
// 曾经数值撞车（旧 MemoFloater 和旧 ForceUpdateModal 的裸字面值恰好都等于
// 一百），阶梯化后 modal 家族整体压在 memoFloater 之下，巧合冲突自然消解，
// 不是刻意设计。
// ============================================================================

export const Z_LAYERS = {
  /** primitives/Modal.tsx 默认层级，未显式覆盖 zIndex 的常规居中弹窗都落这档。 */
  modal: 50,
  /** DevServerLauncher 启动 Dev Server 弹窗。W3 收口批次迁 Modal primitive 时
   *  保留原裸字面值（八十），未刻意设计要压过谁，现状如此。 */
  devServerModal: 80,
  /** ForceUpdateModal 强制更新遮罩：不可关闭的顶层拦截层。迁 Modal primitive
   *  时刻意保留"压过其他常规 modal"的语义，原裸字面值一百。 */
  forceUpdateModal: 100,
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
  /** AgentSwitcher/ModelSwitcher 的 createPortal 弹层。原裸字面值九千九百
   *  九十九，与旧 Toast 同值、低于旧 SessionReplaySummaryDialog 的一万；
   *  新值与 toast 同档、低于 criticalOverlay，相对关系原样保留。 */
  statusPopover: 2000,
  /** SessionReplaySummaryDialog 会话回放摘要弹窗。原裸字面值一万，刻意压过
   *  旧 Toast 的九千九百九十九；新阶梯 toast=2000，本档留在最高位保持压制
   *  关系不倒挂。 */
  criticalOverlay: 3000,
} as const;
