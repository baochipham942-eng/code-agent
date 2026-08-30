// ============================================================================
// 首屏 tip 行（Grok 风格）：空会话时在输入框上方显示一条轮换提示。
// 纯数据 + 纯函数，可单测；App mount 时按种子取一条，不随帧重滚。
// tips 数组刻意不 export（knip production 门：测试经 pickStartupTip 行为断言）。
// ============================================================================

const STARTUP_TIPS: readonly string[] = [
  'Tip: ! 前缀直接跑 shell（走权限审批链，输出截断展示）',
  'Tip: Ctrl+R 搜索历史 prompt · ↑ 逐条回看',
  'Tip: /model 无参打开模型选择器 · /ps 查看后台任务',
  'Tip: turn 运行中直接打字，Enter 自动排队 follow-up',
  'Tip: Esc 取消当前 turn · Ctrl+Q 双击退出',
];

/** 按种子取一条 tip（调用方传 Date.now() 即可，无需加密随机） */
export function pickStartupTip(seed: number): string {
  const index = Math.abs(Math.floor(seed)) % STARTUP_TIPS.length;
  return STARTUP_TIPS[index];
}
