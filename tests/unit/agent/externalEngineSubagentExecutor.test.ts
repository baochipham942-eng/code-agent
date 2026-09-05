import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAgentEngineKind } from '../../../src/shared/contract/agentEngine';
import type { SubagentExecutionRequest } from '../../../src/host/agent/subagentExecutorTypes';
import { WORKTREE_BASE_DIR } from '../../../src/host/agent/agentWorktreePath';

const mocks = vi.hoisted(() => ({
  adapterRun: vi.fn(),
  modelOverride: vi.fn(),
}));

vi.mock('../../../src/host/services/agentEngine/agentEngineAdapterRegistry', () => ({
  getExternalEngineAdapter: () => ({ run: mocks.adapterRun }),
}));

vi.mock('../../../src/host/agent/agentDefinition', () => ({
  getSubagentModelOverride: (...args: unknown[]) => mocks.modelOverride(...args),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ExternalEngineSubagentExecutor } from '../../../src/host/agent/externalEngineSubagentExecutor';

describe('ExternalEngineSubagentExecutor', () => {
  let worktreePath: string;
  let outsidePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await fs.mkdir(WORKTREE_BASE_DIR, { recursive: true });
    worktreePath = await fs.mkdtemp(path.join(WORKTREE_BASE_DIR, 'executor-test-'));
    outsidePath = await fs.mkdtemp(path.join(path.dirname(WORKTREE_BASE_DIR), 'executor-outside-'));
    mocks.modelOverride.mockReturnValue('openai/gpt-5.3-codex');
    mocks.adapterRun.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      engine: 'codex_cli',
      status: 'completed',
      outputText: 'done',
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(worktreePath, { recursive: true, force: true });
    await fs.rm(outsidePath, { recursive: true, force: true });
  });

  it('uses the in-tool idle grade on the actual adapter and cleans up timers', async () => {
    vi.useFakeTimers();
    mocks.adapterRun.mockImplementation(({ abortSignal }) => new Promise(resolve => {
      abortSignal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }));
    const run = new ExternalEngineSubagentExecutor().execute(makeRequest('codex_cli', outsidePath));
    await vi.advanceTimersByTimeAsync(130_000);
    const signal = mocks.adapterRun.mock.calls[0][0].abortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(480_000);
    expect(await run).toMatchObject({ success: false, cancellationReason: 'idle-timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves cancellation when the adapter rejects after abort', async () => {
    vi.useFakeTimers();
    mocks.adapterRun.mockImplementation(({ abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const run = new ExternalEngineSubagentExecutor().execute(makeRequest('codex_cli', outsidePath));
    await vi.advanceTimersByTimeAsync(610_000);
    expect(await run).toMatchObject({ success: false, cancellationReason: 'idle-timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes workspace_write to Codex inside a Neo-managed worktree', async () => {
    const result = await new ExternalEngineSubagentExecutor().execute(makeRequest('codex_cli', worktreePath));

    expect(result).toMatchObject({ success: true, output: 'done', toolsUsed: [], iterations: 1 });
    expect(mocks.adapterRun).toHaveBeenCalledWith(expect.objectContaining({
      cwd: worktreePath,
      workspaceRoot: worktreePath,
      permissionProfile: 'workspace_write',
      executionOrigin: 'subagent',
      model: 'openai/gpt-5.3-codex',
      emitEvent: expect.any(Function),
    }));
  });

  it('keeps external execution read-only outside the managed worktree base', async () => {
    await new ExternalEngineSubagentExecutor().execute(makeRequest('codex_cli', outsidePath));

    expect(mocks.adapterRun).toHaveBeenCalledWith(expect.objectContaining({
      permissionProfile: 'read_only',
    }));
  });

  it('fails loudly when a worktree run lacks the workspace_write capability', async () => {
    const result = await new ExternalEngineSubagentExecutor().execute(makeRequest('mimo_code', worktreePath));

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('未声明 worktree 写入能力'),
    });
    expect(mocks.adapterRun).not.toHaveBeenCalled();
  });

  it('maps a missing execute capability to a failed human-readable result', async () => {
    const result = await new ExternalEngineSubagentExecutor().execute(
      makeRequest('qoder_work' as ExternalAgentEngineKind, outsidePath),
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('当前不支持子代理执行') });
    expect(mocks.adapterRun).not.toHaveBeenCalled();
  });
});

function makeRequest(engine: ExternalAgentEngineKind, cwd: string): SubagentExecutionRequest {
  const abortController = new AbortController();
  return {
    prompt: `[工作目录: ${cwd}]\nwrite files`,
    config: {
      name: '测试专家',
      roleId: 'test-role',
      engine,
      systemPrompt: 'system',
      availableTools: [],
    },
    context: {
      sessionId: 'session-1',
      cwd,
      modelConfig: { provider: 'openai', model: 'gpt-5.3-codex' },
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => false },
      events: { emit: () => undefined },
      abortSignal: abortController.signal,
      executionAgentId: 'agent-1',
    },
  } as SubagentExecutionRequest;
}
