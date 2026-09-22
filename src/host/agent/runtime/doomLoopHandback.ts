import { INTERACTION_TIMEOUTS } from '../../../shared/constants/timeouts';
import { HostReasonCode } from '../../../shared/contract';
import { noteUnattendedRunTerminal } from '../unattendedApprovalTerminal';
import type { DoomLoopGuard } from './doomLoopGuard';
import { emitGoalAbort } from './goalAbort';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import type { RuntimeContext } from './runtimeContext';

/** 无人值守卡死直接终态的原因码。cron 收尾把它写进执行记录。 */
export const DOOM_LOOP_HANDBACK_STOP = 'DOOM_LOOP_HANDBACK_STOP';

export const DOOM_LOOP_HANDBACK_RETRY_NUDGE = [
  '<doom-loop-guard>',
  'The user asked you to try a different method instead of stopping.',
  'Do not repeat the same tool call with the same arguments.',
  'Use a different tool, different arguments, or explain the blocker.',
  '</doom-loop-guard>',
].join('\n');

export type DoomLoopHandbackChoice = 'retry' | 'stop';

type Waiter = (choice: DoomLoopHandbackChoice) => void;
const waiters = new Map<string, Waiter>();

export function answerDoomLoopHandback(sessionId: string, choice: DoomLoopHandbackChoice): boolean {
  const waiter = waiters.get(sessionId);
  if (!waiter) return false;
  waiters.delete(sessionId);
  waiter(choice);
  return true;
}

/** 交互会话等用户点卡片。超时视为停止，避免 run 挂住。 */
export function waitForDoomLoopHandback(
  sessionId: string,
  timeoutMs: number = INTERACTION_TIMEOUTS.USER_QUESTION,
): Promise<DoomLoopHandbackChoice | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(sessionId);
      resolve('timeout');
    }, timeoutMs);
    waiters.set(sessionId, (choice) => {
      clearTimeout(timer);
      resolve(choice);
    });
  });
}

/** 无人值守不弹卡，直接记下终态原因码。 */
export function stopUnattendedDoomLoop(sessionId: string): void {
  noteUnattendedRunTerminal(sessionId, DOOM_LOOP_HANDBACK_STOP);
}

function abortGoalIfPending(ctx: RuntimeContext, iterations: number): void {
  emitGoalAbort(ctx, {
    code: HostReasonCode.GoalAbortRepeatedAction,
    modelText: '相同工具调用在警告后仍反复出现，目标未达成',
    turns: iterations,
    tokensUsed: goalTokensUsedWithSwarm(ctx),
  });
}

/** retry = 注入 nudge 续跑；stop = 调用方把 run 标 aborted。goal 模式的中止卡只在 stop 时发。 */
export async function settleDoomLoopHandback(
  ctx: RuntimeContext,
  guard: DoomLoopGuard,
  iterations: number,
  injectNudge: (text: string) => void,
): Promise<'retry' | 'stop'> {
  if (ctx.unattendedTurn === true) {
    stopUnattendedDoomLoop(ctx.sessionId);
    abortGoalIfPending(ctx, iterations);
    return 'stop';
  }
  ctx.onEvent({ type: 'doom_loop_handback', data: { sessionId: ctx.sessionId } });
  const choice = await waitForDoomLoopHandback(ctx.sessionId);
  if (choice === 'retry') {
    guard.resetAfterHandback();
    injectNudge(DOOM_LOOP_HANDBACK_RETRY_NUDGE);
    return 'retry';
  }
  abortGoalIfPending(ctx, iterations);
  return 'stop';
}
