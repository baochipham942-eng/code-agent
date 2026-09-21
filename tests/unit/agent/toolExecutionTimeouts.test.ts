import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitToolExecutionWithTimeout,
  createToolProgressClock,
  mcpServerForTool,
} from '../../../src/host/agent/runtime/toolExecutionTimeout';
import {
  getToolExecutionTimeoutMs,
  isToolExecutionOutcomeUnknown,
  TOOL_EXECUTION_TIMEOUTS,
} from '../../../src/shared/constants/timeouts';

describe('unified tool execution timeout policy', () => {
  afterEach(() => vi.useRealTimers());

  it('leaves bash to its command-level timeout', () => {
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
  });

  it('uses the MCP tier and a bounded default for other tools', () => {
    expect(getToolExecutionTimeoutMs('mcp')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('MCPUnified')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('mcp__server__search')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('mcp_server_search')).toBeUndefined();
    expect(getToolExecutionTimeoutMs('image_generate')).toBe(TOOL_EXECUTION_TIMEOUTS.DEFAULT);
    expect(getToolExecutionTimeoutMs('Task')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('AgentSpawn')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
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

  it('resolves server names for legacy MCP argument shapes', () => {
    expect(mcpServerForTool('MCPUnified', { server: 'docs' })).toBe('docs');
    expect(mcpServerForTool('mcp', { server: 'docs' })).toBe('docs');
    expect(mcpServerForTool('MCPUnified', { serverName: 'docs' })).toBe('docs');
    expect(mcpServerForTool('mcp', { server: 'docs', serverName: 'other' })).toBe('docs');
    expect(mcpServerForTool('mcp__docs__search', {})).toBe('docs');
    expect(mcpServerForTool('mcp_docs_search', {})).toBe('docs');
  });

  it('does not derive a server from MCP management tools', () => {
    expect(mcpServerForTool('mcp_add_server', { name: 'docs' })).toBeUndefined();
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

  it('turns an inactive execution into a model-visible failure', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const onTimeout = vi.fn();
    const pending = new Promise<{ success: boolean }>(() => undefined);
    const resultPromise = awaitToolExecutionWithTimeout(pending, {
      timeoutMs: TOOL_EXECUTION_TIMEOUTS.MCP,
      getInactiveMs: () => TOOL_EXECUTION_TIMEOUTS.MCP,
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
