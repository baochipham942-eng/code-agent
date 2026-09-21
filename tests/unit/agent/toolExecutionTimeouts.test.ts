import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitToolExecutionWithTimeout,
  createToolProgressClock,
} from '../../../src/host/agent/runtime/toolExecutionTimeout';
import {
  beginApprovalWait,
  clearApprovalWait,
  endApprovalWait,
  getApprovalWaitMs,
} from '../../../src/host/tools/toolExecutionTelemetry';
import {
  getToolExecutionTimeoutMs,
  isToolExecutionOutcomeUnknown,
  TOOL_EXECUTION_TIMEOUTS,
} from '../../../src/shared/constants/timeouts';

describe('unified tool execution timeout policy', () => {
  afterEach(() => vi.useRealTimers());

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
    expect(getToolExecutionTimeoutMs('web_search')).toBe(TOOL_EXECUTION_TIMEOUTS.SEARCH_RETRIEVAL);
    expect(getToolExecutionTimeoutMs('read_pdf')).toBe(TOOL_EXECUTION_TIMEOUTS.SEARCH_RETRIEVAL);
    expect(getToolExecutionTimeoutMs('WebSearch')).toBe(TOOL_EXECUTION_TIMEOUTS.SEARCH_RETRIEVAL);
    expect(getToolExecutionTimeoutMs('WebFetch')).toBe(TOOL_EXECUTION_TIMEOUTS.SEARCH_RETRIEVAL);
    expect(getToolExecutionTimeoutMs('ReadDocument')).toBe(TOOL_EXECUTION_TIMEOUTS.SEARCH_RETRIEVAL);
    expect(getToolExecutionTimeoutMs('ExternalSearch')).toBe(TOOL_EXECUTION_TIMEOUTS.SEARCH_RETRIEVAL);
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
    expect(getToolExecutionTimeoutMs('image_generate')).toBe(TOOL_EXECUTION_TIMEOUTS.DEFAULT);
    expect(getToolExecutionTimeoutMs('Task')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('workflow_orchestrate')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('local_speech_to_text')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('http_request')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('Explore')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('Skill')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
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

  it('only subtracts approval wait accumulated since the last activity', () => {
    let current = 10_000;
    let approvalWaitMs = 5_000;
    const clock = createToolProgressClock({
      startedAt: 0,
      getApprovalWaitMs: () => approvalWaitMs,
      now: () => current,
    });
    // 启动前的历史审批等待在首次进展封账后不再抵扣。
    clock.markActivity();
    current = 20_000;
    expect(clock.getInactiveMs()).toBe(10_000);
    // 进展之后新发生的审批等待仍然抵扣（等审批不算 inactive）。
    approvalWaitMs = 9_000;
    current = 30_000;
    expect(clock.getInactiveMs()).toBe(16_000);
    // 再次进展后，此前的等待再次封账。
    clock.markActivity();
    current = 40_000;
    expect(clock.getInactiveMs()).toBe(10_000);
  });

  it('pauses the inactivity clock while an approval is pending', async () => {
    vi.useFakeTimers();
    const toolCallId = 'approval-wait-test';
    const clock = createToolProgressClock({
      startedAt: Date.now(),
      getApprovalWaitMs: (now) => getApprovalWaitMs(toolCallId, now),
    });
    clock.markActivity();
    // 审批挂起远超预算也不累计 inactivity（用户看卡的时间不算无进展）。
    beginApprovalWait(toolCallId);
    await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_TIMEOUTS.DEFAULT * 2);
    expect(clock.getInactiveMs()).toBeLessThan(TOOL_EXECUTION_TIMEOUTS.DEFAULT);
    // 审批结束后钟恢复走时，且已结束的等待被全额抵扣。
    endApprovalWait(toolCallId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clock.getInactiveMs()).toBe(1_000);
    clearApprovalWait(toolCallId);
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
    const onTimeout = vi.fn();
    const pending = new Promise<{ success: boolean }>(() => undefined);
    const resultPromise = awaitToolExecutionWithTimeout(pending, {
      timeoutMs: TOOL_EXECUTION_TIMEOUTS.DEFAULT,
      getInactiveMs: () => TOOL_EXECUTION_TIMEOUTS.DEFAULT,
      abort,
      onTimeout,
      buildTimeoutResult: (elapsedMs) => ({ success: false, elapsedMs }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(resultPromise).resolves.toMatchObject({ success: false });
    expect(abort).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
