// ============================================================================
// jevAdvisory 域词条（Jev 注入扫描 advisory 提示行）—— zh/en 同文件相邻维护。
// 决策卡域（decisionCard.ts）归母单冻结，本域独立成文件。
// ============================================================================

export const jevAdvisoryZh = {
  jevAdvisory: {
    remoteContentFlagged: '注意：本轮读到的远端内容疑似含有注入指令，放行前请再核对一遍。',
  },
};

export const jevAdvisoryEn: typeof jevAdvisoryZh = {
  jevAdvisory: {
    remoteContentFlagged: 'Caution: remote content read this turn looks like a possible injection attempt. Double-check before allowing.',
  },
};
