// ============================================================================
// Loop（会话内循环）契约
//
// loop 与 cron/schedule 的根本区别：loop 是「会话内、由结果驱动、会自己收敛」的
// 反复执行——在当前 session 上反复调 orchestrator.sendMessage，直到达成软条件 /
// 用户喊停 / 触到轮次上限。每轮回复走当前 session 的正常流式链路自然显示在聊天里。
// ============================================================================

export type LoopStatus = 'running' | 'stopped' | 'completed' | 'failed';
export type LoopStopReason = 'user' | 'max_turns' | 'condition_met' | 'error';

/** 安全网：未显式指定 maxTurns 时的默认轮次上限，防止失控。 */
export const LOOP_DEFAULT_MAX_TURNS = 50;
/** agent 判断软停止条件已满足时，在回复中输出的标记。 */
export const LOOP_DONE_MARKER = '[[LOOP_DONE]]';
/** 自定步调：agent 用 `[[LOOP_WAIT]] <秒数>` 指定下一轮间隔。 */
export const LOOP_WAIT_MARKER = '[[LOOP_WAIT]]';

export interface LoopRunConfig {
  sessionId: string;
  /** 循环反复执行的主体 prompt。 */
  prompt: string;
  /** 固定间隔（毫秒）。缺省 = 自定步调（由模型每轮决定下次延迟，默认立即继续）。 */
  intervalMs?: number;
  /** 最大轮次上限；缺省用 LOOP_DEFAULT_MAX_TURNS。 */
  maxTurns?: number;
  /** 软停止条件的自然语言描述（满足即停）。 */
  until?: string;
}

export interface LoopRunState {
  id: string;
  sessionId: string;
  prompt: string;
  intervalMs?: number;
  maxTurns: number;
  until?: string;
  /** 已完成的轮次数。 */
  turn: number;
  status: LoopStatus;
  stopReason?: LoopStopReason;
  startedAt: number;
  lastTurnAt?: number;
  /** 下一轮预计执行时间（运行中且处于等待间隔时有值）。 */
  nextRunAt?: number;
  error?: string;
}
