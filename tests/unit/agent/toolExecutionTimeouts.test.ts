import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolExecutionWatchdog } from '../../../src/host/agent/runtime/toolExecutionTimeout';
import {
  beginApprovalWait,
  clearApprovalWait,
  endApprovalWait,
  getApprovalWaitMs,
} from '../../../src/host/tools/toolExecutionTelemetry';
import { endHumanWait, isHumanWaitActive } from '../../../src/host/services/infra/timeoutController';
import {
  getToolExecutionTimeoutMs,
  isToolExecutionOutcomeUnknown,
} from '../../../src/shared/constants/timeouts';

// 档位预算真源是 src/shared/constants/timeouts.ts 的 TOOL_EXECUTION_TIMEOUTS
// （不导出，production dead-export 棘轮）；这里用字面量钉对外契约。
const DEFAULT_BUDGET_MS = 120_000;
const LONG_RUNNING_BUDGET_MS = 600_000;
const REPORT_INTERVAL_MS = 5_000;

interface ProbeResult {
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

function makeWatchdog(toolName: string, toolCallId: string) {
  return createToolExecutionWatchdog({
    toolCallId,
    toolName,
    startedAt: Date.now(),
    onEvent: vi.fn(),
    onTimeoutWarn: vi.fn(),
  });
}

describe('unified tool execution timeout policy', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearApprovalWait('approval-overlap-test');
    clearApprovalWait('approval-pauses-clock');
    clearApprovalWait('approval-seal-test');
    while (isHumanWaitActive('session-tool-timeout')) endHumanWait('session-tool-timeout');
  });

  it('leaves bash and interaction tools to their own boundaries', () => {
    expect(getToolExecutionTimeoutMs('bash')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('Bash')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('bash_script')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('AskUserQuestion')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('confirm_action')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('ProposeCanvasOps')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('ProposeSlidesOps')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('ProposeVideoOps')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('RequestDesignAutonomy')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('plan_review')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('wait_agent')).toBeUndefined();
  });

  it('uses the search/retrieval tier for web search and document retrieval', () => {
    expect(getToolExecutionTimeoutMs('web_search')).toBe(DEFAULT_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('read_pdf')).toBe(DEFAULT_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('WebSearch')).toBe(DEFAULT_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('WebFetch')).toBe(DEFAULT_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('ReadDocument')).toBe(DEFAULT_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('ExternalSearch')).toBe(DEFAULT_BUDGET_MS);
  });

  it('leaves self-limiting wait tools to their own bounded budget', () => {
    expect(getToolExecutionTimeoutMs('terminal_wait')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('gui_agent')).toBeUndefined();
    // 前台 spawn_agent 由 raceForegroundBlockingBudget 到点转后台，外层不得抢先。
    expect(getToolExecutionTimeoutMs('spawn_agent')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('AgentSpawn')).toBeUndefined();
  });

  it('uses the MCP tier and a bounded default for other tools', () => {
    expect(getToolExecutionTimeoutMs('mcp')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('MCPUnified')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('mcp__server__search')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('mcp_server_search')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('image_generate')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('Task')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('workflow_orchestrate')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('local_speech_to_text')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('http_request')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('Explore')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('Skill')).toBe(LONG_RUNNING_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('grep')).toBe(DEFAULT_BUDGET_MS);
    expect(getToolExecutionTimeoutMs('workflow')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('collect_agent')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('task_output')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('Process')).toBeUndefined();
  });

  it('marks non-idempotent write tools as outcome-unknown on timeout', () => {
    expect(isToolExecutionOutcomeUnknown('mail_send')).toBe(true);
    expect(isToolExecutionOutcomeUnknown('github_pr')).toBe(true);
    expect(isToolExecutionOutcomeUnknown('calendar_create_event')).toBe(true);
    expect(isToolExecutionOutcomeUnknown('append_file')).toBe(true);
    expect(isToolExecutionOutcomeUnknown('web_search')).toBe(false);
    expect(isToolExecutionOutcomeUnknown('read_file')).toBe(false);
    expect(isToolExecutionOutcomeUnknown('image_analyze')).toBe(false);
  });

  it('counts overlapping approval waits once across their union span', async () => {
    vi.useFakeTimers();
    const toolCallId = 'approval-overlap-test';
    // 并行子 agent 共用父 toolCallId 同时弹卡：先结束的卡不得清掉等待起点。
    beginApprovalWait(toolCallId);
    beginApprovalWait(toolCallId);
    await vi.advanceTimersByTimeAsync(1_000);
    endApprovalWait(toolCallId);
    expect(getApprovalWaitMs(toolCallId, Date.now())).toBe(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    endApprovalWait(toolCallId);
    // 整段并集 2000ms 只记一次，不重复累计。
    expect(getApprovalWaitMs(toolCallId, Date.now())).toBe(2_000);
    clearApprovalWait(toolCallId);
  });

  it('turns an inactive execution into a model-visible failure', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = makeWatchdog('grep', 'timeout-fires');
    const pending = new Promise<ProbeResult>(() => undefined);
    const resultPromise = watchdog.awaitExecution(pending, abort);

    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + REPORT_INTERVAL_MS);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.metadata?.timedOut).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    watchdog.stop();
  });

  it('marks the timeout result outcome-unknown only for write-class tools', async () => {
    vi.useFakeTimers();
    const writeWatchdog = makeWatchdog('mail_send', 'timeout-write');
    const writeResultPromise = writeWatchdog.awaitExecution(new Promise<ProbeResult>(() => undefined), vi.fn());
    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + REPORT_INTERVAL_MS);
    const writeResult = await writeResultPromise;
    expect(writeResult.metadata?.outcomeUnknown).toBe(true);
    expect(writeResult.error).toContain('outcome unknown');
    writeWatchdog.stop();

    const readWatchdog = makeWatchdog('web_search', 'timeout-read');
    const readResultPromise = readWatchdog.awaitExecution(new Promise<ProbeResult>(() => undefined), vi.fn());
    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + REPORT_INTERVAL_MS);
    const readResult = await readResultPromise;
    expect(readResult.metadata?.outcomeUnknown).toBe(false);
    expect(readResult.error).not.toContain('outcome unknown');
    readWatchdog.stop();
  });

  it('lets self-limiting tools outlive the generic budget', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = makeWatchdog('terminal_wait', 'self-limiting-pass');
    let settled = false;
    const execution = new Promise<ProbeResult>((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve({ success: true });
      }, DEFAULT_BUDGET_MS * 2);
    });
    const resultPromise = watchdog.awaitExecution(execution, abort);
    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS * 3);
    await resultPromise;
    expect(settled).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('pauses the inactivity clock while an approval is pending', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = makeWatchdog('grep', 'approval-pauses-clock');
    const resultPromise = watchdog.awaitExecution(new Promise<ProbeResult>(() => undefined), abort);

    // 审批挂起远超预算也不触发超时（用户看卡的时间不算无进展）。
    beginApprovalWait('approval-pauses-clock');
    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS * 2);
    expect(abort).not.toHaveBeenCalled();
    // 审批结束后钟恢复走时，已结束的等待被全额抵扣，预算从头计。
    endApprovalWait('approval-pauses-clock');
    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + REPORT_INTERVAL_MS);
    expect(abort).toHaveBeenCalledOnce();
    await resultPromise;
    watchdog.stop();
  });

  it('seals historical approval wait at each activity reset', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = makeWatchdog('grep', 'approval-seal-test');
    const resultPromise = watchdog.awaitExecution(new Promise<ProbeResult>(() => undefined), abort);

    // 先产生一段历史审批等待，随后有一次进展（markActivity 把等待封账）。
    beginApprovalWait('approval-seal-test');
    await vi.advanceTimersByTimeAsync(60_000);
    endApprovalWait('approval-seal-test');
    watchdog.markActivity();
    // 封账后：进展之后满一个预算即超时。若历史等待被重复抵扣，则要再等 60s 才触发。
    await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + REPORT_INTERVAL_MS);
    expect(abort).toHaveBeenCalledOnce();
    await resultPromise;
    watchdog.stop();
  });
});
