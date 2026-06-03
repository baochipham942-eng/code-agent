// ============================================================================
// 孤儿回收父探活谓词（swarm 护栏 P1-2 #5）
// ============================================================================
//
// 后台 detached 子代理同进程执行，父 run 正常结束（session → idle）或被新 run 取代
// 时不会触发 abort，子代理会成孤儿继续烧预算。这里提供纯谓词判断"父 run 是否仍活"，
// 由 executeSpawnAgent 包成 isParentAlive 回调注入子代理，子循环每轮探活。
//
// 抽成纯函数便于确定性单测（活跃状态集合 + startTime 区分同 session 新 run）。
// 用 type-only import SessionStatus，运行时擦除，不引入 task→agent 循环依赖。
// ============================================================================

import type { SessionStatus } from '../task/TaskManager';

/** 父 run 视为"活着"的活跃状态集合（其余如 idle/error 视为已结束）。 */
const ACTIVE_RUN_STATUSES: readonly SessionStatus[] = [
  'running',
  'paused',
  'cancelling',
  'queued',
];

/**
 * 判断后台 detached 子代理的父 run 是否仍活着。
 *
 * 活 = 父 session 处于活跃 run 状态 **且** startTime 与 spawn 时捕获的一致。
 * 后者用于区分"同 session 起了新 run"——新 run 会刷新 startTime，旧 run 派生的
 * 后台子代理届时应被判为孤儿回收，而不是误认父还活着。
 */
export function isParentRunAlive(
  state: { status: SessionStatus; startTime?: number },
  spawnStartTime: number | undefined,
): boolean {
  return (
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(state.status) &&
    state.startTime === spawnStartTime
  );
}
