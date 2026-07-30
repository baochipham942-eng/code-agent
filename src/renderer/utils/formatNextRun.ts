// ============================================================================
// formatNextRun —— 下次运行时间的人话格式化（今天只显 HH:mm，其他日期带月日）。
// 原SidebarCapabilityZone 私有样板，批P 审美关抽成公共 util：
// 侧栏自动化行与协作空间自动化卡弹窗复用同一套，不重写。
// ============================================================================

/** 下次运行时间：今天只显 HH:mm，其他日期带月日 */
export function formatNextRun(ts: number, locale: string): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`;
}
