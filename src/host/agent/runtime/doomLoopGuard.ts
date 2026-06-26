// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — session/processor.ts + session/prompt.ts
// ============================================================================
// Doom Loop 三层防护 — 主循环级防跑飞
// ============================================================================
//
// L1 doom-loop：同名同参工具调用连续 ×3 → 注入强警告；警告后仍重复 → 中止本次
//    run 把控制权交还用户（MiMo 走 permission.ask 人工确认；Neo 主循环没有
//    人工审批通道，以"中止 + 通知"作为架构等价物）。
// L2 repeated-step：整步行动签名（全部工具调用 stableStringify 排序 key）连续
//    ×3 → 注入 nudge 让模型自己换策略，不拒绝。
// L3 invalid-output：空文本输出自动续接，带上限防无限续接。
//
// 计数器生命周期 = 一次 run（每轮用户输入重新实例化即重置）。

export const DOOM_LOOP_THRESHOLD = 3;
export const REPEATED_STEP_THRESHOLD = 3;
export const EMPTY_OUTPUT_CONTINUATION_LIMIT = 3;

/** JSON 序列化但排序 object key，防止 key 重排导致的签名假阴性 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{'
    + keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
      .join(',')
    + '}'
  );
}

export interface GuardToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface DoomLoopCheck {
  level: 'none' | 'repeated-step' | 'doom-loop' | 'doom-loop-abort';
  nudge?: string;
}

function callSignature(toolCall: GuardToolCall): string {
  return 'tool:' + toolCall.name + ':' + stableStringify(toolCall.arguments ?? {});
}

const DOOM_LOOP_NUDGE = [
  '<doom-loop-guard>',
  `You have made the exact same tool call (same tool, same arguments) ${DOOM_LOOP_THRESHOLD} times in a row.`,
  'This is a loop — repeating it again will NOT produce a different result.',
  'Stop and change strategy now: use a different tool, different arguments, or explain the blocker to the user.',
  'If you repeat the same call again, this run will be stopped.',
  '</doom-loop-guard>',
].join('\n');

const REPEATED_STEP_NUDGE = [
  '<system-reminder>',
  `Your last ${REPEATED_STEP_THRESHOLD} steps have been identical — you appear to be`,
  'repeating the same action without making progress. Stop and reconsider:',
  'the current approach is not working. Try a different strategy, use a',
  'different tool, or if you are blocked, explain the blocker to the user',
  'instead of repeating the same step again.',
  '</system-reminder>',
].join('\n');

const EMPTY_OUTPUT_NUDGE = [
  '<system-reminder>',
  'Your previous response contained no usable answer (it had only reasoning, or was empty).',
  'Provide a final answer to the user now, or call a valid tool to make progress on the task.',
  'Do not respond with only reasoning/thinking.',
  '</system-reminder>',
].join('\n');

export class DoomLoopGuard {
  /** 连续相同单工具调用的签名与连击数（跨 step 累计） */
  private lastCallSignature: string | null = null;
  private identicalCallStreak = 0;
  /** 最近 step 的行动签名（用于 L2） */
  private recentStepSignatures: string[] = [];
  /** L1 警告是否已发出（再犯升级为 abort） */
  private doomLoopNudged = false;
  /** L3 空输出续接计数 */
  private emptyOutputContinuations = 0;

  /** 记录一个 step 的全部工具调用，返回防护判定 */
  recordStep(toolCalls: GuardToolCall[]): DoomLoopCheck {
    if (toolCalls.length === 0) return { level: 'none' };

    // L1：逐个调用维护"连续相同"连击
    for (const toolCall of toolCalls) {
      const sig = callSignature(toolCall);
      if (sig === this.lastCallSignature) {
        this.identicalCallStreak += 1;
      } else {
        this.lastCallSignature = sig;
        this.identicalCallStreak = 1;
        this.doomLoopNudged = false;
      }
    }

    if (this.identicalCallStreak >= DOOM_LOOP_THRESHOLD) {
      if (this.doomLoopNudged) {
        return { level: 'doom-loop-abort' };
      }
      this.doomLoopNudged = true;
      return { level: 'doom-loop', nudge: DOOM_LOOP_NUDGE };
    }

    // L2：整步签名重复检测（排除单调用场景 — 已由 L1 更早覆盖）。
    // 签名按 multiset 处理（排序后拼接），并行调用换序不应绕过检测。
    const stepSig = toolCalls.map(callSignature).sort().join('\n');
    this.recentStepSignatures.push(stepSig);
    if (this.recentStepSignatures.length > REPEATED_STEP_THRESHOLD) {
      this.recentStepSignatures.shift();
    }
    const repeating =
      this.recentStepSignatures.length === REPEATED_STEP_THRESHOLD
      && this.recentStepSignatures.every((s) => s === this.recentStepSignatures[0]);
    if (repeating) {
      return { level: 'repeated-step', nudge: REPEATED_STEP_NUDGE };
    }

    return { level: 'none' };
  }

  /** 记录一次空输出，返回续接或停止决定（L3） */
  recordEmptyOutput(): { action: 'continue' | 'stop'; nudge?: string } {
    if (this.emptyOutputContinuations >= EMPTY_OUTPUT_CONTINUATION_LIMIT) {
      return { action: 'stop' };
    }
    this.emptyOutputContinuations += 1;
    return { action: 'continue', nudge: EMPTY_OUTPUT_NUDGE };
  }
}
