// ============================================================================
// 本机系统时区 —— cron「本地时间」语义的单一取值点（N-FIX-CRON-TZ-PLACEHOLDER-MANUAL-CWD）。
// 消费方：晨间分诊模板的 cronTimezone（cronTemplates.ts）、时区输入框的灰色占位
// （CronScheduleFields.tsx）。空时区存 undefined，host 侧 croner 按本机时区调度，
// 占位符必须显示同一个答案，否则灰字在骗非上海用户。
// ============================================================================

/** 本机系统时区（晨间分诊这类「本地时间」模板用，不钉死 Asia/Shanghai）。 */
export function localCronTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}
