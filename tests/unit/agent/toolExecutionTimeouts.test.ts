import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitToolExecutionWithTimeout } from '../../../src/host/agent/runtime/toolExecutionTimeout';
import {
  getToolExecutionTimeoutMs,
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
  });

  it('uses the MCP tier and a bounded default for other tools', () => {
    expect(getToolExecutionTimeoutMs('mcp')).toBe(TOOL_EXECUTION_TIMEOUTS.MCP);
    expect(getToolExecutionTimeoutMs('mcp__server__search')).toBe(TOOL_EXECUTION_TIMEOUTS.MCP);
    expect(getToolExecutionTimeoutMs('mcp_server_search')).toBe(TOOL_EXECUTION_TIMEOUTS.MCP);
    expect(getToolExecutionTimeoutMs('image_generate')).toBe(TOOL_EXECUTION_TIMEOUTS.DEFAULT);
    expect(getToolExecutionTimeoutMs('Task')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('AgentSpawn')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
    expect(getToolExecutionTimeoutMs('workflow')).toBe(TOOL_EXECUTION_TIMEOUTS.LONG_RUNNING);
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
