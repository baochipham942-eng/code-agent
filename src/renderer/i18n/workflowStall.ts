// ============================================================================
// workflowStall 域词条（WorkflowInlineMonitor 两级「无进展」提示，N-WF-STALL-UI）
// —— zh/en 同文件相邻维护。档位语义见 src/renderer/utils/workflowStallLevel.ts：
// quiet = 超过软阈值（2 分钟）只是提示；long = 硬停顿且宿主检测器已提醒过 Neo。
// ============================================================================

export const workflowStallZh = {
  workflowStall: {
    quiet: '暂无进展',
    long: '长时间无进展，已提醒 Neo',
  },
};

export const workflowStallEn: typeof workflowStallZh = {
  workflowStall: {
    quiet: 'No progress for a while',
    long: 'No progress for a long time; Neo has been notified',
  },
};
