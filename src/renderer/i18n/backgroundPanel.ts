// ============================================================================
// 后台任务面板词条（BackgroundSessionPanel）—— zh/en 同文件相邻维护。
// 独立文件避免 zh.ts/en.ts 撞 max-lines 棘轮（同 chatInput.ts 先例）。
// ============================================================================

export const backgroundPanelZh = {
  backgroundPanel: {
    title: '后台任务',
    minimizedLabel: '{count} 个后台任务',
    minimizedAria: '展开后台任务面板',
    collapseAria: '收起后台任务面板',
    foregroundHint: '点击任务切换到前台',
    foregroundAria: '把「{title}」切回前台',
    completedLine: '已完成',
    failedLine: '执行失败',
    cancelledLine: '已停止',
    maxIterationsLine: '已达轮次上限，已停止（部分结果已保留）',
    durationSeconds: '{n}秒',
    durationMinutes: '{n}分钟',
    durationHours: '{n}小时{m}分钟',
  },
};

export const backgroundPanelEn: typeof backgroundPanelZh = {
  backgroundPanel: {
    title: 'Background tasks',
    minimizedLabel: '{count} background tasks',
    minimizedAria: 'Expand background task panel',
    collapseAria: 'Collapse background task panel',
    foregroundHint: 'Click a task to bring it back',
    foregroundAria: 'Bring "{title}" back to the foreground',
    completedLine: 'Completed',
    failedLine: 'Failed',
    cancelledLine: 'Stopped',
    maxIterationsLine: 'Step limit reached, stopped (partial results kept)',
    durationSeconds: '{n}s',
    durationMinutes: '{n}m',
    durationHours: '{n}h {m}m',
  },
};
