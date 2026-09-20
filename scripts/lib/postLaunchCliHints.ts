// ============================================================================
// postlaunch-score CLI 的收尾提示（N-POSTLAUNCH-SCORE-ZERO）
// 住在 scripts/lib：唯一消费方是 scripts/postlaunch-score.ts，放 src/ 会被生产可达性棘轮判「断电文件」。
// ----------------------------------------------------------------------------
// 两种 0 轮是两件事，提示必须互斥：被锁挡住时已经有明确出路，再叠一句
// 「窗口里没有可评的轮」是自相矛盾的。做成一个函数是为了这条互斥有测试守着——
// 在 CLI 里写成两条并列的 if，下一个人改动时看不出它们不能同时成立。
// ============================================================================

export interface PostLaunchCliOutcome {
  examinedTurns: number;
  locked: boolean;
}

export const LOCKED_HINT
  = '这个库上另有一次评分正在跑（30 分钟内的锁），本次一轮没评、一分没扣；等它跑完再来。';

/**
 * 2026-09-19 那次排查：扫到 0 轮，先后排除了库空、SQL、开库路径、锁表、days clamp、
 * 回放、turn 匹配键八个方向，最后真因是打开库时 WAL 还没被这份 shm 索引到
 * （DatabaseService 打一条 stale -shm 自愈 WARN，自愈在本次打开之后才生效，再跑一次就正常）。
 * CLI 当时只说「扫到 0 轮」，没给任何下一步。
 */
export const ZERO_TURN_HINT
  = '扫到 0 轮：这个窗口里没有可评的轮。若上面日志出现过 stale -shm 自愈，'
  + '说明本次打开时 WAL 里的数据还看不见——自愈已在这次生效，直接再跑一次即可。';

/** 收尾提示；没有可说的就返回 null（评到了轮就不用解释什么）。 */
export function resolveZeroTurnHint(outcome: PostLaunchCliOutcome): string | null {
  if (outcome.locked) return LOCKED_HINT;
  if (outcome.examinedTurns === 0) return ZERO_TURN_HINT;
  return null;
}
