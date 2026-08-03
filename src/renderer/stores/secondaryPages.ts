// ============================================================================
// 二级页注册面 —— 会话区互斥的整窗/inline 二级页只在这里登记一次。
//
// 由来：原先七个 setter 各手抄一份「打开我就关别人」的清单，漏过一次
// （知识记忆面板忘了关 InAppValidation）。收成一张表之后，新增二级页只加一行，
// 对账测试会把漏登记的 appStore show* 键直接点名。
//
// 用法（appStore 内）：
//   set({ ...SECONDARY_PAGES_CLOSED, showXxx: true })   // 自身键放展开之后才不被覆盖
// 想「回到会话区」时走 appStore.closeSecondaryPages()——落到会话
// （switchSession / 新建会话 / 打开右栏视图）的路径都经它收口。
// ============================================================================

export const SECONDARY_PAGES_CLOSED = {
  showPromptManager: false,
  showActivityPanel: false,
  showTimeCapabilityCenter: false,
  showDesktopPanel: false,
  showLab: false,
  showLibraryPanel: false,
  showCapabilityHub: false,
  showCronCenter: false,
  showLocalOpsPanel: false,
  showEvalCenter: false,
  showProjectCollaborationPage: false,
  showProjectSpacePage: false,
  expertDetailRoleId: null,
} as const;

// appStore 里的 show* 状态并不全是会话区二级页。这里的排除必须显式写出，
// 让新增 show* 键默认进入对账范围；只有确认它是 overlay、模态或 workbench
// 视图时，才允许把它列为例外。
export const SECONDARY_PAGE_SHOW_EXCLUSIONS = [
  'showSettings', // overlay；提示词管理从设置打开时需要保留设置作为返回落点
  'showWorkspace', // 会话工作区面板
  'showAgentTeamPanel', // 任务协作 overlay
  'showCapturePanel', // 截图模态
  'showFileExplorer', // 右侧 workbench 文件视图，不是 App 的二级页分支
  'showOptionalUpdateModal', // 系统更新模态
  'showPlanningPanel', // 会话内规划面板
  'showDAGPanel', // Workflow overlay
] as const;
