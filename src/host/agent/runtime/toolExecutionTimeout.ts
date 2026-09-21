import {
  TOOL_PROGRESS,
  TOOL_TIMEOUT_THRESHOLDS,
  getToolExecutionTimeoutMs,
  isToolExecutionOutcomeUnknown,
} from '../../../shared/constants';
import type { AgentEvent } from '../../../shared/contract';
import { clearApprovalWait, getApprovalWaitMs } from '../../tools/toolExecutionTelemetry';

export interface ToolProgressClock {
  /** 有一次进展：重置 inactivity 钟，并把此前累积的审批等待封账（不再从后续 inactivity 里扣）。 */
  markActivity: () => void;
  /** 距上次进展的「活跃外」时长：只减去上次进展之后新发生的审批等待。 */
  getInactiveMs: () => number;
}

/**
 * inactivity 钟 + 审批等待的记账。
 *
 * 审批等待全程单调累加（含工具启动前那次审批）。若每次都用「now - lastActivityAt -
 * 审批全程等待」，progress 钟重置之后历史审批等待会被重复抵扣，超时被同样时长推迟；
 * 所以每次 markActivity 都把当时已累积的审批等待封账，之后只扣增量。
 */
export function createToolProgressClock(options: {
  startedAt: number;
  getApprovalWaitMs: (now: number) => number;
  now?: () => number;
}): ToolProgressClock {
  const now = options.now ?? Date.now;
  let lastActivityAt = options.startedAt;
  let approvalWaitAtLastActivityMs = options.getApprovalWaitMs(options.startedAt);
  return {
    markActivity: () => {
      lastActivityAt = now();
      approvalWaitAtLastActivityMs = options.getApprovalWaitMs(lastActivityAt);
    },
    getInactiveMs: () => {
      const current = now();
      const approvalWaitSinceLastActivity = Math.max(
        0,
        options.getApprovalWaitMs(current) - approvalWaitAtLastActivityMs,
      );
      return current - lastActivityAt - approvalWaitSinceLastActivity;
    },
  };
}

export async function awaitToolExecutionWithTimeout<T>(
  execution: Promise<T>,
  options: {
    timeoutMs: number;
    getInactiveMs: () => number;
    abort: () => void;
    onTimeout: (elapsedMs: number) => void;
    buildTimeoutResult: (elapsedMs: number) => T;
  },
): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setInterval(() => {
      const inactiveMs = options.getInactiveMs();
      if (inactiveMs < options.timeoutMs) return;
      if (timer) clearInterval(timer);
      timer = undefined;
      options.abort();
      options.onTimeout(inactiveMs);
      resolve(options.buildTimeoutResult(inactiveMs));
    }, TOOL_PROGRESS.REPORT_INTERVAL);
    execution.then(resolve, reject);
  }).finally(() => {
    if (timer) clearInterval(timer);
  });
}

/**
 * 超时结果的统一构造。写类工具只在启动前查一次 abortSignal，外层 inactivity 超时
 * 触发时副作用可能已经完成——标 outcome-unknown 让模型先核实状态再决定是否重试，
 * 避免把超时当失败直接重试造成重复发送/重复创建。
 */
function buildToolTimeoutResult(options: {
  toolName: string;
  timeoutMs: number;
  elapsedMs: number;
}): {
  success: false;
  error: string;
  metadata: { timedOut: true; inactivityTimeoutMs: number; elapsedMs: number; outcomeUnknown: boolean };
} {
  const outcomeUnknown = isToolExecutionOutcomeUnknown(options.toolName);
  return {
    success: false,
    error: outcomeUnknown
      ? `Tool execution timed out after ${options.timeoutMs}ms without progress; outcome unknown — the tool may have completed its side effect, verify before retrying`
      : `Tool execution timed out after ${options.timeoutMs}ms without progress`,
    metadata: {
      timedOut: true,
      inactivityTimeoutMs: options.timeoutMs,
      elapsedMs: options.elapsedMs,
      outcomeUnknown,
    },
  };
}

export interface ToolExecutionWatchdogOptions {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  onEvent: (event: AgentEvent) => void;
  onTimeoutWarn: (elapsedMs: number, thresholdMs: number) => void;
}

export interface ToolExecutionWatchdog {
  /** 有一次进展：重置 inactivity 钟（并把已累积审批等待封账）。 */
  markActivity: () => void;
  /** 开始周期上报 tool_progress / 超阈值 tool_timeout 事件。 */
  startProgressReporter: () => void;
  /** 等待执行完成；工具带统一 inactivity 预算时，超预算 abort 并返回超时结果。 */
  awaitExecution: <T>(execution: Promise<T>, abort: () => void) => Promise<T>;
  /** 收口：停上报、清审批等待账。幂等。 */
  stop: () => void;
}

/**
 * 单次工具调用的进度/超时守门：progress 上报、inactivity 预算、审批等待记账全部收口
 * 在这里，引擎只拿四个动作（markActivity / startProgressReporter / awaitExecution / stop）。
 * MCP 工具不走外层预算（getToolExecutionTimeoutMs 返回 undefined），elicitation/OAuth
 * 挂起由 MCP 层自己的 60s 调用预算与停车挂起机制处理。
 */
export function createToolExecutionWatchdog(options: ToolExecutionWatchdogOptions): ToolExecutionWatchdog {
  const { toolCallId, toolName, startedAt, onEvent } = options;
  const timeoutThreshold = TOOL_TIMEOUT_THRESHOLDS[toolName] ?? TOOL_PROGRESS.DEFAULT_THRESHOLD;
  const executionTimeoutMs = getToolExecutionTimeoutMs(toolName);
  const progressClock = createToolProgressClock({
    startedAt,
    getApprovalWaitMs: (now) => getApprovalWaitMs(toolCallId, now),
  });
  let timeoutEmitted = false;
  let progressInterval: ReturnType<typeof setInterval> | undefined;

  return {
    markActivity: () => progressClock.markActivity(),
    startProgressReporter: () => {
      progressInterval = setInterval(() => {
        // 卡在人身上的时间不算工具耗时：语音态/无人值守的审批是「停车挂起」（不限时），
        // 把等人那段算进来的话，用户还在看审批卡就先被告知「工具执行超时」（2026-07-26 真机）。
        const now = Date.now();
        const elapsed = now - startedAt - getApprovalWaitMs(toolCallId, now);
        onEvent({
          type: 'tool_progress',
          data: { toolCallId, toolName, elapsedMs: elapsed },
        });
        if (!timeoutEmitted && elapsed > timeoutThreshold) {
          timeoutEmitted = true;
          onEvent({
            type: 'tool_timeout',
            data: { toolCallId, toolName, elapsedMs: elapsed, threshold: timeoutThreshold },
          });
          options.onTimeoutWarn(elapsed, timeoutThreshold);
        }
      }, TOOL_PROGRESS.REPORT_INTERVAL);
    },
    awaitExecution: <T>(execution: Promise<T>, abort: () => void): Promise<T> => {
      if (executionTimeoutMs === undefined) return execution;
      return awaitToolExecutionWithTimeout(execution, {
        timeoutMs: executionTimeoutMs,
        getInactiveMs: () => progressClock.getInactiveMs(),
        abort,
        onTimeout: (elapsedMs) => onEvent({
          type: 'tool_timeout',
          data: { toolCallId, toolName, elapsedMs, threshold: executionTimeoutMs },
        }),
        buildTimeoutResult: (elapsedMs) => buildToolTimeoutResult({ toolName, timeoutMs: executionTimeoutMs, elapsedMs }) as T,
      });
    },
    stop: () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = undefined;
      }
      clearApprovalWait(toolCallId);
    },
  };
}
