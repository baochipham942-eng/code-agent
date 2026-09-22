import { INTERACTION_TIMEOUTS } from '../../../shared/constants/timeouts';
import { HostReasonCode } from '../../../shared/contract';
import { hasInteractiveUi } from '../../platform/windowBridge';
import { noteUnattendedRunTerminal } from '../unattendedApprovalTerminal';
import type { DoomLoopGuard } from './doomLoopGuard';
import { emitGoalAbort } from './goalAbort';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import type { RuntimeContext } from './runtimeContext';

/** 无人值守卡死直接终态的原因码。cron 收尾把它写进执行记录。 */
const DOOM_LOOP_HANDBACK_STOP = 'DOOM_LOOP_HANDBACK_STOP';

const DOOM_LOOP_HANDBACK_RETRY_NUDGE = [
  '<doom-loop-guard>',
  'The user asked you to try a different method instead of stopping.',
  'Do not repeat the same tool call with the same arguments.',
  'Use a different tool, different arguments, or explain the blocker.',
  '</doom-loop-guard>',
].join('\n');

export type DoomLoopHandbackChoice = 'retry' | 'stop';

type Waiter = (choice: DoomLoopHandbackChoice | 'steered') => void;
const waiters = new Map<string, Waiter>();

export function answerDoomLoopHandback(sessionId: string, choice: DoomLoopHandbackChoice): boolean {
  const waiter = waiters.get(sessionId);
  if (!waiter) return false;
  waiters.delete(sessionId);
  waiter(choice);
  return true;
}

type DoomLoopHandbackWait = DoomLoopHandbackChoice | 'timeout' | 'stop' | 'steered';

/**
 * 交互会话等用户点卡片。取消/打断立刻停；超时也停。
 * 同一会话上的新等待不会被上一轮的计时器清掉。
 */
function waitForDoomLoopHandback(
  sessionId: string,
  timeoutMs: number = INTERACTION_TIMEOUTS.USER_QUESTION,
  signal?: AbortSignal,
): Promise<DoomLoopHandbackWait> {
  if (signal?.aborted) return Promise.resolve('stop');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DoomLoopHandbackWait) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (waiters.get(sessionId) === onChoice) waiters.delete(sessionId);
      resolve(result);
    };
    const onChoice = (choice: DoomLoopHandbackChoice | 'steered') => finish(choice);
    const onAbort = () => finish('stop');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    waiters.set(sessionId, onChoice);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** 用户在卡片出现后改口发了新消息。结束等待，让这一轮接着推理，而不是再干等。 */
export function releaseDoomLoopHandbackForSteer(sessionId: string): boolean {
  const waiter = waiters.get(sessionId);
  if (!waiter) return false;
  waiters.delete(sessionId);
  waiter('steered');
  return true;
}

/** 无人值守不弹卡，直接记下终态原因码。 */
function stopUnattendedDoomLoop(sessionId: string): void {
  noteUnattendedRunTerminal(sessionId, DOOM_LOOP_HANDBACK_STOP);
}

function abortGoalIfPending(ctx: RuntimeContext, iterations: number): void {
  if (!ctx.goalMode?.isPending()) return;
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
  timeoutMs: number = INTERACTION_TIMEOUTS.USER_QUESTION,
): Promise<'retry' | 'stop'> {
  if (ctx.unattendedTurn === true) {
    stopUnattendedDoomLoop(ctx.sessionId);
    abortGoalIfPending(ctx, iterations);
    return 'stop';
  }
  // 评测和交互式 CLI 没有能点这张卡的界面。直接停，避免白等 5 分钟。
  if (!hasInteractiveUi()) {
    abortGoalIfPending(ctx, iterations);
    return 'stop';
  }
  ctx.onEvent({ type: 'doom_loop_handback', data: { sessionId: ctx.sessionId } });
  const choice = await waitForDoomLoopHandback(
    ctx.sessionId,
    timeoutMs,
    ctx.control.runAbortController?.signal,
  );
  if (choice === 'retry' || choice === 'steered') {
    guard.resetAfterHandback();
    if (choice === 'retry') injectNudge(DOOM_LOOP_HANDBACK_RETRY_NUDGE);
    return 'retry';
  }
  abortGoalIfPending(ctx, iterations);
  return 'stop';
}
