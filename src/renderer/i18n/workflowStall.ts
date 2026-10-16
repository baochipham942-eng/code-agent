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
    // 硬档文案要单行塞进 max-w-3xl 卡片头（743px）且不挤计数：中文 148px，英文缩到同量级
    // （原句 'No progress for a long time; Neo has been notified' 50 字符会顶爆换行）。
    long: 'Stalled for a long time; Neo notified',
  },
};
