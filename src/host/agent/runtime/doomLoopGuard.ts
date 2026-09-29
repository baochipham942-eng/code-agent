import { normalizeErrorMessage } from '../../lightMemory/normalizeErrorMessage';

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
// 结果信号（recordResults，不改 L1/L2）：
// polling_repeat / same_error_family 与 L1/L2 同一阈值 ×3——两次仍可能是
// 重试，第三次相同观察才算没有进展。abab_action_cycle 的窗口是 4，因为
// A,B,A,B 本身要四步才成环（A≠B）；再少一步看不出交替。
// 命中只 nudge，不中止；每个 run 每个信号至多一次。
//
// 计数器生命周期 = 一次 run（每轮用户输入重新实例化即重置）。

export const DOOM_LOOP_THRESHOLD = 3;
export const REPEATED_STEP_THRESHOLD = 3;
export const EMPTY_OUTPUT_CONTINUATION_LIMIT = 3;

/** 与 L1/L2 对齐：连续 3 次相同轮询观察才算空转。 */
const POLLING_REPEAT_THRESHOLD = 3;
/** 与 L1/L2 对齐：同一规范化错误族连续 3 次才 nudge。 */
const SAME_ERROR_FAMILY_THRESHOLD = 3;
/** A,B,A,B 需要四步才成立；这是环的长度，不是另一套 ×3 计数。 */
const ABAB_CYCLE_STEPS = 4;

const SIGNAL_POLLING_REPEAT = 'polling_repeat';
const SIGNAL_SAME_ERROR_FAMILY = 'same_error_family';
const SIGNAL_ABAB_ACTION_CYCLE = 'abab_action_cycle';

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

interface GuardCallResult {
  name: string;
  arguments?: Record<string, unknown>;
  success: boolean;
  /** 原始输出或错误文本。规范化在 guard 内做，调用方不必先处理。 */
  summary: string;
}

interface GuardSignalCheck {
  signals: string[];
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
  /** 最近四步整步签名，只给 ABAB；不替代 L2 的三步窗口。 */
  private actionCycle: string[] = [];
  /** 连续相同轮询观察（task + 状态 + 规范化正文）。 */
  private pollKey: string | null = null;
  private pollStreak = 0;
  /** 连续相同规范化错误族。 */
  private errorFamily: string | null = null;
  private errorFamilyStreak = 0;
  /** 本 run 已 nudge 过的信号。再命中不再注入。 */
  private firedSignals = new Set<string>();

  /** 记录一个 step 的全部工具调用，返回防护判定 */
  recordStep(toolCalls: GuardToolCall[]): DoomLoopCheck {
    if (toolCalls.length === 0) return { level: 'none' };

    const stepSig = toolCalls.map(callSignature).sort().join('\n');
    this.actionCycle.push(stepSig);
    if (this.actionCycle.length > ABAB_CYCLE_STEPS) this.actionCycle.shift();

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
    // L1 提前返回时不写入这个三步窗口，与改动前一致。
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

  /**
   * 用户选了「换个方法」。连击、警告标记和整步签名都清掉。
   * 下一次相同调用从 1 重新数，要再满 3 次才警告，警告后再重复才中止。
   */
  resetAfterHandback(): void {
    this.lastCallSignature = null;
    this.identicalCallStreak = 0;
    this.doomLoopNudged = false;
    this.recentStepSignatures = [];
    this.actionCycle = [];
    this.pollKey = null;
    this.pollStreak = 0;
    this.errorFamily = null;
    this.errorFamilyStreak = 0;
  }

  /**
   * 工具执行完后回灌这一步的结果摘要。
   * 不改 recordStep 的返回；L1/L2 仍在执行前判定。这里只追加三个信号。
   */
  recordResults(step: GuardCallResult[]): GuardSignalCheck {
    const signals: string[] = [];
    for (const call of step) {
      this.notePoll(call, signals);
      this.noteErrorFamily(call, signals);
    }
    if (this.ababHit()) this.takeSignal(SIGNAL_ABAB_ACTION_CYCLE, signals);
    if (signals.length === 0) return { signals };
    return { signals, nudge: signalNudge(signals) };
  }

  /** 记录一次空输出，返回续接或停止决定（L3） */
  recordEmptyOutput(): { action: 'continue' | 'stop'; nudge?: string } {
    if (this.emptyOutputContinuations >= EMPTY_OUTPUT_CONTINUATION_LIMIT) {
      return { action: 'stop' };
    }
    this.emptyOutputContinuations += 1;
    return { action: 'continue', nudge: EMPTY_OUTPUT_NUDGE };
  }

  private notePoll(call: GuardCallResult, signals: string[]): void {
    const taskId = backgroundPollTaskId(call);
    if (!taskId) {
      this.pollKey = null;
      this.pollStreak = 0;
      return;
    }
    const observed = observePoll(call.summary);
    // 身份是后台任务，不是整段参数。timeout/block 变化仍算同一次轮询。
    const key = `${taskId}\n${observed.status}\n${observed.body}`;
    if (key === this.pollKey) this.pollStreak += 1;
    else {
      this.pollKey = key;
      this.pollStreak = 1;
    }
    if (this.pollStreak >= POLLING_REPEAT_THRESHOLD) this.takeSignal(SIGNAL_POLLING_REPEAT, signals);
  }

  private noteErrorFamily(call: GuardCallResult, signals: string[]): void {
    if (call.success) {
      this.errorFamily = null;
      this.errorFamilyStreak = 0;
      return;
    }
    const family = normalizeSignalText(call.summary).trim();
    if (!family) {
      this.errorFamily = null;
      this.errorFamilyStreak = 0;
      return;
    }
    if (family === this.errorFamily) this.errorFamilyStreak += 1;
    else {
      this.errorFamily = family;
      this.errorFamilyStreak = 1;
    }
    if (this.errorFamilyStreak >= SAME_ERROR_FAMILY_THRESHOLD) {
      this.takeSignal(SIGNAL_SAME_ERROR_FAMILY, signals);
    }
  }

  private ababHit(): boolean {
    if (this.actionCycle.length < ABAB_CYCLE_STEPS) return false;
    const [first, second, third, fourth] = this.actionCycle;
    return first === third && second === fourth && first !== second;
  }

  private takeSignal(name: string, signals: string[]): void {
    if (this.firedSignals.has(name) || signals.includes(name)) return;
    this.firedSignals.add(name);
    signals.push(name);
  }
}

const POLL_ACTIONS = new Set(['poll', 'output', 'log']);

function signalNudge(signals: string[]): string {
  return [
    '<system-reminder>',
    `Runaway guard (${signals.join(', ')}): these steps are not making progress.`,
    'Stop and change strategy. Use a different tool, different arguments, or explain the blocker to the user.',
    'Do not keep polling the same task, repeating the same error, or alternating the same two steps.',
    '</system-reminder>',
  ].join('\n');
}

/** 数字、引号、路径、时间戳、uuid 抹平后再交给 failure journal 的归一化。 */
function normalizeSignalText(message: string): string {
  return normalizeErrorMessage(
    message
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'ID')
      .replace(/\b[0-9a-f]{16,}\b/gi, 'ID')
      .replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:[\w.@+-]+(?:\/|\\))+[\w.@+-]*/g, 'PATH')
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, 'TS')
      .replace(/\b\d{2}:\d{2}:\d{2}\b/g, 'TS'),
  );
}

function backgroundPollTaskId(call: GuardCallResult): string | null {
  const name = call.name.toLowerCase();
  const args = call.arguments ?? {};
  if (name === 'process') {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
    if (!POLL_ACTIONS.has(action)) return null;
  } else if (name !== 'task_output') {
    return null;
  }
  const taskId = args.task_id ?? args.session_id;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : null;
}

function observePoll(summary: string): { status: string; body: string } {
  const prefixed = summary.match(/^status=([^\n]*)\n([\s\S]*)$/);
  const text = prefixed ? prefixed[2] : summary;
  let jsonStatus: string | undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { status?: unknown };
      if (typeof parsed.status === 'string') jsonStatus = parsed.status;
    } catch {
      jsonStatus = undefined;
    }
  }
  const line = text.match(/(?:^|\n)\s*Status:\s*([^\n]+)/i);
  const xml = text.match(/<status>([^<]+)<\/status>/i);
  const rawStatus = (prefixed?.[1] ?? jsonStatus ?? line?.[1] ?? xml?.[1])?.trim();
  const body = normalizeSignalText(stripStatusMarkup(text)).trim();
  if (rawStatus) return { status: normalizeSignalText(rawStatus).trim(), body };
  return { status: body, body };
}

function stripStatusMarkup(text: string): string {
  return text
    .replace(/^status=[^\n]*\n/, '')
    .replace(/(?:^|\n)\s*Status:\s*[^\n]*/gi, '\n')
    .replace(/<status>[^<]*<\/status>/gi, '');
}

const guardSignalsByTrace = new WeakMap<object, string[]>();

export function noteGuardSignals(trace: object, signals: readonly string[]): void {
  if (signals.length === 0) return;
  const merged = (guardSignalsByTrace.get(trace) ?? []).slice();
  for (const signal of signals) {
    if (!merged.includes(signal)) merged.push(signal);
  }
  guardSignalsByTrace.set(trace, merged);
}

export function readGuardSignals(trace: object): string[] {
  return (guardSignalsByTrace.get(trace) ?? []).slice();
}

export function collectGuardStepResults(
  messages: readonly {
    role: string;
    toolCalls?: readonly { id: string; name: string; arguments?: Record<string, unknown> }[];
    toolResults?: readonly {
      toolCallId: string;
      success: boolean;
      output?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    }[];
  }[],
  fromIndex: number,
): GuardCallResult[] {
  const added = messages.slice(Math.max(0, fromIndex));
  const calls = added.flatMap((message) => message.toolCalls ?? []);
  const results = added.flatMap((message) => (message.role === 'tool' ? message.toolResults ?? [] : []));
  if (results.length === 0) return [];
  return results.map((result) => {
    const call = calls.find((item) => item.id === result.toolCallId);
    const status = typeof result.metadata?.status === 'string' ? result.metadata.status : undefined;
    const text = result.success ? (result.output ?? '') : (result.error ?? result.output ?? '');
    return {
      name: call?.name ?? '',
      arguments: call?.arguments,
      success: result.success,
      summary: status ? `status=${status}\n${text}` : text,
    };
  });
}
