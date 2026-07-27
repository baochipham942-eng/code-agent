// ============================================================================
// 二级页注册面 —— 会话区互斥的整窗/inline 二级页只在这里登记一次。
//
// 由来：原先七个 setter 各手抄一份「打开我就关别人」的清单，漏过一次
// （知识记忆面板忘了关 InAppValidation）。收成一张表之后，新增二级页只加一行。
//
// 用法（appStore 内）：
//   set({ ...SECONDARY_PAGES_CLOSED, showXxx: true })   // 自身键放展开之后才不被覆盖
// 想「回到会话区」时走 appStore.closeSecondaryPages()——落到会话
// （switchSession / 新建会话 / 打开右栏视图）的路径都经它收口。
// ============================================================================

export const SECONDARY_PAGES_CLOSED = {
  showKnowledgeMemoryPanel: false,
  showLibraryPanel: false,
  showCapabilityHub: false,
  showCronCenter: false,
  showLocalOpsPanel: false,
  showEvalCenter: false,
  showProjectCollaborationPage: false,
  expertDetailRoleId: null,
} as const;
