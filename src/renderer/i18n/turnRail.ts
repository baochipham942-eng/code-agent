// ============================================================================
// 轮次导航词条（N-TURNRAIL，2026-09-02 爸拍板：读屏文案与窄屏按钮用「回到第 N 轮 /
// 第 N 轮」）。独立文件是因为 en.ts 已贴 max-lines 天花板；由 chatTranscript 合并进主词表。
// 用户面词是「轮」（与「第 {n} 轮」「回到这一轮」同族），不用「回合」。
// ============================================================================

export const turnRailZh = {
  turnRail: {
    label: '轮次导航',
    allTurns: '全部 {count} 轮',
    jumpTo: '回到第 {n} 轮',
    turnN: '第 {n} 轮',
    expand: '展开清单',
    collapse: '收起',
  },
};

export const turnRailEn = {
  turnRail: {
    label: 'Turn rail',
    allTurns: 'All {count} turns',
    jumpTo: 'Back to turn {n}',
    turnN: 'Turn {n}',
    expand: 'Expand list',
    collapse: 'Collapse',
  },
};
