// ============================================================================
// Delivery Critic Tests — GAP-013: Generator-Critic 交付前自动验证
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executorState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const providerResolutionState = vi.hoisted(() => ({
  resolveProviderApiKey: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: (request: { prompt: string; config: unknown; context: unknown }) =>
      executorState.execute(request.prompt, request.config, request.context),
  }),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({}),
}));

vi.mock('../../../src/host/agent/hybrid/coreAgents', () => ({
  getModelConfig: () => ({ provider: 'zhipu', model: 'glm-5' }),
}));

// critic 经 resolveReviewModelConfig（goalReviewGate）解析模型，依赖 key 可用性检查
vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderApiKey: providerResolutionState.resolveProviderApiKey,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runDeliveryCritic } from '../../../src/host/agent/deliveryCritic';

const deps = {
  workingDirectory: '/tmp/project',
  sessionId: 'session-1',
};

const modifiedFiles = ['/tmp/project/a.ts', '/tmp/project/b.ts', '/tmp/project/c.ts'];

describe('runDeliveryCritic (GAP-013)', () => {
  beforeEach(() => {
    executorState.execute.mockReset();
    // 默认：powerful tier（mock 为 zhipu/glm-5）有可用 key → 既有用例行为不变
    providerResolutionState.resolveProviderApiKey.mockReset();
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-valid');
  });

  it('passes when critic verdict is PASS', async () => {
    executorState.execute.mockResolvedValue({
      success: true,
      output: '检查了三个文件的修改，逻辑一致，无 Critical 问题。\nVERDICT: PASS',
      iterations: 3,
      toolsUsed: ['read_file'],
    });

    const result = await runDeliveryCritic(modifiedFiles, '修复登录 bug', deps);

    expect(result.pass).toBe(true);
    expect(result.parsed).toBe(true);
  });

  it('blocks delivery when critic verdict is FAIL', async () => {
    executorState.execute.mockResolvedValue({
      success: true,
      output: 'a.ts 第 10 行：空指针解引用，会导致运行时崩溃。\nVERDICT: FAIL',
      iterations: 5,
      toolsUsed: ['read_file', 'grep'],
    });

    const result = await runDeliveryCritic(modifiedFiles, '修复登录 bug', deps);

    expect(result.pass).toBe(false);
    expect(result.parsed).toBe(true);
    expect(result.reason).toContain('空指针');
  });

  it('passes the modified files and user goal to the critic prompt', async () => {
    executorState.execute.mockResolvedValue({
      success: true,
      output: 'VERDICT: PASS',
      iterations: 1,
      toolsUsed: [],
    });

    await runDeliveryCritic(modifiedFiles, '修复登录 bug', deps);

    const [prompt, config] = executorState.execute.mock.calls[0];
    expect(prompt).toContain('修复登录 bug');
    expect(prompt).toContain('/tmp/project/a.ts');
    expect(prompt).toContain('/tmp/project/c.ts');
    expect(config.name).toBe('delivery-critic');
    // 只读工具集
    expect(config.availableTools).not.toContain('bash');
    expect(config.availableTools).not.toContain('write_file');
    expect(config.availableTools).not.toContain('edit_file');
  });

  it('allows delivery when verdict cannot be parsed (no false blocking)', async () => {
    executorState.execute.mockResolvedValue({
      success: true,
      output: '我看了一下，整体还行吧。',
      iterations: 2,
      toolsUsed: ['read_file'],
    });

    const result = await runDeliveryCritic(modifiedFiles, '', deps);

    expect(result.pass).toBe(true);
    expect(result.parsed).toBe(false);
  });

  it('allows delivery when critic subagent fails', async () => {
    executorState.execute.mockResolvedValue({
      success: false,
      output: '',
      error: 'budget exhausted',
      iterations: 10,
      toolsUsed: [],
    });

    const result = await runDeliveryCritic(modifiedFiles, '', deps);

    expect(result.pass).toBe(true);
    expect(result.parsed).toBe(false);
  });

  it('allows delivery when critic subagent throws', async () => {
    executorState.execute.mockRejectedValue(new Error('model unavailable'));

    const result = await runDeliveryCritic(modifiedFiles, '', deps);

    expect(result.pass).toBe(true);
    expect(result.parsed).toBe(false);
    expect(result.reason).toContain('model unavailable');
  });

  // 可用性降级链（与闸2 共用 resolveReviewModelConfig）
  it('powerful tier 无 key 时，critic 用主 run 模型派发', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('');
    executorState.execute.mockResolvedValue({
      success: true,
      output: 'VERDICT: PASS',
      iterations: 1,
      toolsUsed: [],
    });

    await runDeliveryCritic(modifiedFiles, '修复登录 bug', {
      ...deps,
      parentModelConfig: { provider: 'deepseek', model: 'deepseek-chat' } as never,
    });

    const [, , context] = executorState.execute.mock.calls[0];
    expect(context.modelConfig.provider).toBe('deepseek');
    expect(context.modelConfig.model).toBe('deepseek-chat');
  });

  it('powerful tier 有 key 时，critic 仍用 powerful（强模型审查）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-valid');
    executorState.execute.mockResolvedValue({
      success: true,
      output: 'VERDICT: PASS',
      iterations: 1,
      toolsUsed: [],
    });

    await runDeliveryCritic(modifiedFiles, '修复登录 bug', {
      ...deps,
      parentModelConfig: { provider: 'deepseek', model: 'deepseek-chat' } as never,
    });

    const [, , context] = executorState.execute.mock.calls[0];
    // coreAgents mock 的 powerful = zhipu/glm-5
    expect(context.modelConfig.provider).toBe('zhipu');
    expect(context.modelConfig.model).toBe('glm-5');
  });

  // --------------------------------------------------------------------------
  // #7 证据驱动：验证证据写进 prompt + 验证失败时覆盖 fail-open
  // --------------------------------------------------------------------------
  describe('证据驱动 (#7)', () => {
    it('把验证证据写进 critic prompt（none/passed/failed 各异）', async () => {
      executorState.execute.mockResolvedValue({ success: true, output: 'VERDICT: PASS', iterations: 1, toolsUsed: [] });

      await runDeliveryCritic(modifiedFiles, 'g', deps, 'failed');
      expect(executorState.execute.mock.calls[0][0]).toContain('验证命令');
      expect(executorState.execute.mock.calls[0][0]).toContain('失败');

      executorState.execute.mockClear();
      await runDeliveryCritic(modifiedFiles, 'g', deps, 'none');
      expect(executorState.execute.mock.calls[0][0]).toContain('未检测到运行任何验证命令');
    });

    it('验证失败 + critic 抛错 → 阻塞交付（证据覆盖 fail-open）', async () => {
      executorState.execute.mockRejectedValue(new Error('model unavailable'));
      const result = await runDeliveryCritic(modifiedFiles, '', deps, 'failed');
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('验证命令运行失败');
    });

    it('验证未运行/通过 + critic 抛错 → 仍 fail-open 放行（不误伤）', async () => {
      executorState.execute.mockRejectedValue(new Error('model unavailable'));
      expect((await runDeliveryCritic(modifiedFiles, '', deps, 'none')).pass).toBe(true);
      expect((await runDeliveryCritic(modifiedFiles, '', deps, 'passed')).pass).toBe(true);
    });

    it('验证失败 + critic 子代理未完成 → 阻塞交付', async () => {
      executorState.execute.mockResolvedValue({ success: false, output: '', error: 'budget exhausted', iterations: 10, toolsUsed: [] });
      const result = await runDeliveryCritic(modifiedFiles, '', deps, 'failed');
      expect(result.pass).toBe(false);
    });

    it('验证失败 + VERDICT 解析不出 → 阻塞（解析失败不再无条件放行）', async () => {
      executorState.execute.mockResolvedValue({ success: true, output: '看着还行', iterations: 2, toolsUsed: [] });
      const result = await runDeliveryCritic(modifiedFiles, '', deps, 'failed');
      expect(result.pass).toBe(false);
      expect(result.parsed).toBe(false);
    });

    it('验证未运行 + VERDICT 解析不出 → 仍放行（保留 fail-open 安全网）', async () => {
      executorState.execute.mockResolvedValue({ success: true, output: '看着还行', iterations: 2, toolsUsed: [] });
      const result = await runDeliveryCritic(modifiedFiles, '', deps, 'none');
      expect(result.pass).toBe(true);
      expect(result.parsed).toBe(false);
    });

    it('显式 VERDICT 始终优先于验证证据（验证失败但 critic 判 PASS → 放行）', async () => {
      executorState.execute.mockResolvedValue({ success: true, output: '失败与本次改动无关\nVERDICT: PASS', iterations: 2, toolsUsed: [] });
      const result = await runDeliveryCritic(modifiedFiles, '', deps, 'failed');
      expect(result.pass).toBe(true);
      expect(result.parsed).toBe(true);
    });
  });
});
