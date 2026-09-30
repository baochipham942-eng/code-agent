// ============================================================================
// JevWarden — Jev 运行时语义主管（N-JEV-WARDEN-MOCK 机制刀）
// ============================================================================
// 挂点（验收①）：主会话 live loop「工具结果后」——conversationRuntime 工具步
// recordResults 之后（经 toolStepGuardRails 编排）。两处弃选各一行：
// - DoomLoopGuard 内部：guard 是纯计数器，输入面只有调用签名与结果摘要，
//   fake_done 的 files_written 对账与 irreversible 的命令原文都拿不到，且
//   评测侧 subagentDoomLoopGuard 复用同一形状，塞 Jev 依赖会波及评测。
// - 终局消息前：终局点只剩文本，本步工具结果/命令已不在手边，三条规则的
//   现场事实（失败结果、危险命令、guard 信号）无法重建。
//
// fail-open ponytail（验收④）：判官不可用/超时/抛错/坏形状一律不转向（warn
// 留痕）。这与权限线 fail-closed 相反——Warden 不在安全边界上：动作类型里
// 没有 deny、不碰权限链，最坏代价是漏一次纠偏；fail-closed 会把判官故障
// 放大成主循环卡死。
//
// 判官经注入（单测全 mock）；生产缺省懒加载 typesafeProvider.systemOne。
// 开关 CODE_AGENT_JEV_WARDEN 默认关，关时零调用、零注入、零 trace。

import {
  JEV_WARDEN_LIMITS,
  JEV_WARDEN_QUESTIONS,
  JEV_WARDEN_THRESHOLDS,
  isJevWardenEnabled,
  type JevAnswers,
  type JevSystemOneCall,
} from '../../../shared/constants/jevQuestions';
import { createLogger } from '../../services/infra/logger';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';
import { getDecisionHistory, type DecisionOutcome } from '../../security/decisionHistory';
import { isDangerousCommand } from '../../tools/toolExecutorHelpers';
import { isBashToolName } from '../../tools/toolNames';
import { WRITE_TOOLS } from '../loopTypes';
import {
  SIGNAL_ABAB_ACTION_CYCLE,
  SIGNAL_POLLING_REPEAT,
  SIGNAL_SAME_ERROR_FAMILY,
  type DoomLoopCheck,
  type GuardCallResult,
} from './doomLoopGuard';

const logger = createLogger('JevWarden');

type JevWardenRule = 'empty_spin' | 'fake_done' | 'irreversible_unapproved';

/** 验收⑤：与 N-DOOMLOOP-SIGNALS 共享信号枚举，Warden 只认这三个，不另立空转定义。 */
const DOOM_LOOP_SIGNALS: readonly string[] = [
  SIGNAL_POLLING_REPEAT,
  SIGNAL_SAME_ERROR_FAMILY,
  SIGNAL_ABAB_ACTION_CYCLE,
];

/** 挂点输入：本步事实。stepResults 是 collectGuardStepResults 的形状。 */
export interface JevWardenStepInput {
  /** DoomLoopGuard.recordStep 的本步级别（L1/L2）。 */
  guardLevel: DoomLoopCheck['level'];
  /** DoomLoopGuard.recordResults 的本步信号（共享枚举，见 doomLoopGuard 导出）。 */
  guardSignals: readonly string[];
  /** 本步工具调用与结果。 */
  stepResults: readonly GuardCallResult[];
  /** 本步助手文本（tool_use 步可能带正文）。 */
  assistantText?: string;
  /** run 级 abort signal（审查 R2 #4）：已 aborted 直接零调用返回；否则透传给 systemOne。 */
  signal?: AbortSignal;
  /** 转向代数活读器（审查 R3）：调判官前快照、返回后比对，不一致 = 等待期间用户已 steer，裁决丢弃。 */
  steerEpoch?: () => number;
}

/** 动作类型只转向：纠偏注入或强制收尾交还用户；没有 deny，不碰权限链。 */
type JevWardenVerdict =
  | { kind: 'none' }
  | { kind: 'nudge'; rule: JevWardenRule; text: string }
  | { kind: 'force_wrap_up'; rule: JevWardenRule; reason: string; prompt: string };

export interface JevWarden {
  reviewToolStep(input: JevWardenStepInput): Promise<JevWardenVerdict>;
  /** fake_done 置位后第一条非强制收尾终局的纠偏文本；不该拦时返回 null。 */
  interceptFinal(forcedFinal: boolean): string | null;
}

export interface JevWardenOptions {
  /** 判官注入点（测试/回放用替身）。缺省懒加载 typesafeProvider.systemOne。 */
  systemOne?: JevSystemOneCall;
  /** 结构化 trace 记录点（仅开关开且有判面活动时调用）。 */
  recordTrace?: (data: JevWardenTraceData) => void;
  /**
   * 危险命令的权限层审批凭据查询（审查 R2 #5）：返回该命令最近一次的权限决策
   * （ask-approved = 用户显式确认）。缺省按 sessionId 查 decisionHistory 单例。
   */
  approvalLookup?: (command: string) => DecisionOutcome | undefined;
  /** 生产接线传入，用于缺省 approvalLookup 按会话过滤决策历史。 */
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

/** turnTrace 'jev_warden' 事件的 data 形状（真源在 turnTrace.ts 的 TraceEventDataMap 引用本类型）。 */
export interface JevWardenTraceData {
  hit?: string[];
  confirmed?: string[];
  failOpen?: 'judge_error' | 'bad_shape' | 'stale_steer';
  rule?: string;
  intercepted?: 'fake_done_final';
}

const RULE_THRESHOLDS: Record<JevWardenRule, number> = {
  empty_spin: JEV_WARDEN_THRESHOLDS.emptySpin,
  fake_done: JEV_WARDEN_THRESHOLDS.fakeDone,
  irreversible_unapproved: JEV_WARDEN_THRESHOLDS.irreversibleUnapproved,
};

const EMPTY_SPIN_NUDGE = [
  '<jev-warden>',
  'Jev review: your recent steps are spinning — repeating equivalent actions or polling without new information.',
  'Change strategy now: use a different tool or different arguments, or explain the blocker to the user.',
  'If the spin is confirmed again, this run will be wrapped up and handed back to the user.',
  '</jev-warden>',
].join('\n');

const EMPTY_SPIN_WRAP_UP = {
  reason: 'jev-warden: empty spin confirmed twice',
  prompt:
    'Jev review confirmed the run is spinning with no progress. Wrap up now: summarize what was tried, why it is stuck, and hand control back to the user with a concrete next step.',
} as const;

const FAKE_DONE_NUDGE = [
  '<jev-warden>',
  'Jev review: you are about to claim completion, but the recorded tool results and files_written do not support that claim.',
  'Do not declare done yet: verify the deliverable actually exists and earlier failures are resolved, or honestly report what is missing.',
  '</jev-warden>',
].join('\n');

const IRREVERSIBLE_WRAP_UP = {
  reason: 'jev-warden: irreversible action executed without explicit user confirmation',
  prompt:
    'Jev review confirmed an irreversible action was executed this step. Wrap up now: explain exactly which irreversible action was already executed and its impact, and ask the user to confirm before anything further is done.',
} as const;

/** 助手文本自称完成的规则判据（便宜闸，语义裁决归 Jev）。 */
const COMPLETION_CLAIM_PATTERN = /\b(all done|done|completed?|finished)\b|已(经)?(全部)?完成|搞定|写好了/i;

class DisabledJevWarden implements JevWarden {
  reviewToolStep(): Promise<JevWardenVerdict> {
    return Promise.resolve({ kind: 'none' });
  }

  interceptFinal(): string | null {
    return null;
  }
}

class LiveJevWarden implements JevWarden {
  /** empty_spin 本 run 已确认次数：首次纠偏，再次强制收尾。 */
  private emptySpinConfirmations = 0;
  /** fake_done 确认置位：下一条非强制收尾终局被拦一次。 */
  private fakeDonePending = false;
  /** 终局拦截每 run 至多一次。 */
  private fakeDoneIntercepted = false;
  /** 本 run 成功写工具调用写过的文件（files_written 真源）。 */
  private readonly filesWritten = new Set<string>();

  constructor(
    private readonly systemOne: JevSystemOneCall,
    private readonly recordTrace?: (data: Record<string, unknown>) => void,
    private readonly approvalLookup?: (command: string) => DecisionOutcome | undefined,
  ) {}

  async reviewToolStep(input: JevWardenStepInput): Promise<JevWardenVerdict> {
    // 审查 R2 #4：用户已停（cancel/interrupt 会 abort run signal）→ 零调用零转向，
    // 不再为一次无人看的纠偏等判官最多 5s。
    if (input.signal?.aborted) return { kind: 'none' };
    this.noteWrites(input.stepResults);
    const dangerous = dangerousCommandsOf(input.stepResults);
    const unapproved = dangerous.filter((command) => this.approvalOutcomeOf(command) !== 'ask-approved');
    const hit: JevWardenRule[] = [];
    if (input.guardSignals.some((s) => DOOM_LOOP_SIGNALS.includes(s)) || input.guardLevel !== 'none') {
      hit.push('empty_spin');
    }
    if (input.stepResults.some((r) => !r.success) || COMPLETION_CLAIM_PATTERN.test(input.assistantText ?? '')) {
      hit.push('fake_done');
    }
    // 审查 R2 #5：权限层凭据 ask-approved（用户显式确认过这条命令）规则层直接短路，
    // 不问 Jev——已批准的正常操作不该被误判成 irreversible_unapproved。
    if (unapproved.length > 0) hit.push('irreversible_unapproved');
    if (hit.length === 0) return { kind: 'none' };

    const questions: Record<string, (typeof JEV_WARDEN_QUESTIONS)[JevWardenRule]> = {};
    for (const rule of hit) questions[rule] = JEV_WARDEN_QUESTIONS[rule];

    let answers: JevAnswers;
    const epochAtCall = input.steerEpoch?.();
    try {
      answers = await this.systemOne(this.buildState(input, dangerous), questions, { signal: input.signal });
    } catch (error) {
      // fail-open ponytail：见模块头。与权限线 fail-closed 相反，Warden 故障不转向。
      logger.warn(`[JevWarden] judge unavailable (${error instanceof Error ? error.message : String(error)}); fail-open, no steering`);
      this.recordTrace?.({ hit, failOpen: 'judge_error' });
      return { kind: 'none' };
    }

    // 审查 R3：判官等待期间用户已 steer（epoch 推进）→ 旧工具步的裁决整体丢弃：
    // 不计数、不置标、不转向，让 run 按新指令继续推理。
    if (epochAtCall !== undefined && input.steerEpoch?.() !== epochAtCall) {
      logger.warn('[JevWarden] verdict discarded: user steered during judge wait');
      this.recordTrace?.({ hit, failOpen: 'stale_steer' });
      return { kind: 'none' };
    }

    // 审查 R4 #2：先完整校验本次响应里所有命中问题的形状——任一坏形状即整体
    // fail-open 零转向（验收④「一律」），不让其余有效答案单独触发动作。
    const nouls = new Map<JevWardenRule, number>();
    for (const rule of hit) {
      const noul = readNoulProbability(answers[rule]);
      if (noul === null) {
        logger.warn(`[JevWarden] bad-shaped answer for ${rule}; fail-open, no steering`);
        this.recordTrace?.({ hit, failOpen: 'bad_shape', rule });
        return { kind: 'none' };
      }
      nouls.set(rule, noul);
    }
    const confirmed = new Set<JevWardenRule>();
    for (const [rule, noul] of nouls) {
      if (noul >= RULE_THRESHOLDS[rule]) confirmed.add(rule);
    }
    this.recordTrace?.({ hit, confirmed: [...confirmed] });

    if (confirmed.has('irreversible_unapproved')) {
      return { kind: 'force_wrap_up', rule: 'irreversible_unapproved', ...IRREVERSIBLE_WRAP_UP };
    }
    if (confirmed.has('fake_done')) this.fakeDonePending = true;
    if (confirmed.has('empty_spin')) {
      this.emptySpinConfirmations += 1;
      if (this.emptySpinConfirmations === 1) {
        return { kind: 'nudge', rule: 'empty_spin', text: EMPTY_SPIN_NUDGE };
      }
      return { kind: 'force_wrap_up', rule: 'empty_spin', ...EMPTY_SPIN_WRAP_UP };
    }
    return { kind: 'none' };
  }

  interceptFinal(forcedFinal: boolean): string | null {
    if (forcedFinal || !this.fakeDonePending || this.fakeDoneIntercepted) return null;
    this.fakeDoneIntercepted = true;
    this.fakeDonePending = false;
    logger.warn('[JevWarden] fake_done final intercepted; injecting correction');
    this.recordTrace?.({ intercepted: 'fake_done_final' });
    return FAKE_DONE_NUDGE;
  }

  private noteWrites(stepResults: readonly GuardCallResult[]): void {
    for (const result of stepResults) {
      if (!result.success || !WRITE_TOOLS.includes(result.name)) continue;
      const path = result.arguments?.path ?? result.arguments?.file_path ?? result.arguments?.filePath;
      if (typeof path === 'string' && path.length > 0) this.filesWritten.add(path);
    }
  }

  /** 审查 R2 #1：外发给 api.typesafe.ai 的每个字符串先过 guardSensitiveText（同 jevCompaction 口径）。 */
  private sanitize(text: string): string {
    return guardSensitiveText(text.slice(0, JEV_WARDEN_LIMITS.maxResultChars), {
      surface: 'telemetry',
      mode: 'model-context',
    });
  }

  /** 权限层审批凭据：查询失败/无记录一律 undefined（判据按未确认处理，保守方向是问 Jev）。 */
  private approvalOutcomeOf(command: string): DecisionOutcome | undefined {
    try {
      return this.approvalLookup?.(command);
    } catch {
      return undefined;
    }
  }

  /** state 投影：集合一律命名键（jevQuestions 块头约定），体积受 JEV_WARDEN_LIMITS 约束。 */
  private buildState(input: JevWardenStepInput, dangerous: readonly string[]): Record<string, unknown> {
    const files = [...this.filesWritten].slice(0, JEV_WARDEN_LIMITS.maxFilesWritten);
    return {
      assistant_text: this.sanitize(input.assistantText ?? ''),
      guard_level: input.guardLevel,
      guard_signals: namedRecord(input.guardSignals, 'signal'),
      files_written: namedRecord(files.map((file) => this.sanitize(file)), 'file'),
      tool_results: namedRecord(
        input.stepResults.map((r) => ({
          tool: r.name,
          success: r.success,
          summary: this.sanitize(r.summary),
        })),
        'result',
      ),
      dangerous_commands: namedRecord(
        dangerous.slice(0, JEV_WARDEN_LIMITS.maxDangerousCommands).map((command) => ({
          command: this.sanitize(command),
          approval: this.approvalOutcomeOf(command) ?? 'unknown',
        })),
        'command',
      ),
    };
  }
}

function namedRecord<T>(values: readonly T[], prefix: string): Record<string, T> {
  const record: Record<string, T> = {};
  values.forEach((value, index) => {
    record[`${prefix}_${index + 1}`] = value;
  });
  return record;
}

function dangerousCommandsOf(stepResults: readonly GuardCallResult[]): string[] {
  const commands: string[] = [];
  for (const result of stepResults) {
    // 审查 R2 #3：失败/被拒/被拦的命令没有真正执行，不算「已执行的不可逆动作」。
    if (!result.success) continue;
    if (!isBashToolName(result.name)) continue;
    const command = result.arguments?.command;
    if (typeof command === 'string' && isDangerousCommand(command)) commands.push(command);
  }
  return commands;
}

/** noul 答案校验：非有限数或越界 0-1 ⇒ null（fail-open，不许静默补默认值）。 */
function readNoulProbability(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object') return null;
  const noul = (answer as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) return null;
  return noul;
}

/**
 * 缺省审批凭据查询：从权限决策历史（recordDecision 落账的 summary 截断 80 字符口径）
 * 找该会话该命令最近一次的决策。返回 undefined = 无记录。
 */
function lookupApprovalOutcome(sessionId: string, command: string): DecisionOutcome | undefined {
  const summary = command.substring(0, 80);
  const entries = getDecisionHistory().getAll();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.sessionId !== sessionId || entry.summary !== summary) continue;
    if (!isBashToolName(entry.toolName)) continue;
    return entry.outcome;
  }
  return undefined;
}

/**
 * per-run 实例化（计数器/置位随用户输入重置）。开关关时返回零行为 no-op：
 * 判官零调用、零注入、零 trace（验收④）。
 */
export function createJevWarden(options: JevWardenOptions = {}): JevWarden {
  if (!isJevWardenEnabled(options.env)) return new DisabledJevWarden();
  const systemOne = options.systemOne
    ?? ((state, questions, opts) => import('../../model/providers/typesafeProvider').then((m) => m.systemOne(state, questions, opts)));
  const approvalLookup = options.approvalLookup
    ?? (options.sessionId ? (command: string) => lookupApprovalOutcome(options.sessionId ?? '', command) : undefined);
  return new LiveJevWarden(systemOne, options.recordTrace, approvalLookup);
}
