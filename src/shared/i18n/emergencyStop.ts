/** One user-facing signal for the global emergency stop. */
export function emergencyStopMessage(locale: string): string {
  return locale.toLowerCase().startsWith('zh')
    ? '已暂停新操作；移除数据目录中的 ESTOP 文件后可恢复。'
    : 'New actions are paused; remove ESTOP from the data directory to resume.';
}
