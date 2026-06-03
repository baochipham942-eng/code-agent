// ============================================================================
// Goal Review Gate Tests — 闸2 软评审：模型可用性降级链 + verdict 解析
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executorState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const providerResolutionState = vi.hoisted(() => ({
  resolveProviderApiKey: vi.fn(),
}));

vi.mock('../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => executorState,
}));

vi.mock('../../../src/main/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({}),
}));

// powerful tier 固定模拟成生产默认（xiaomi/mimo）
vi.mock('../../../src/main/agent/hybrid/coreAgents', () => ({
  getModelConfig: () => ({ provider: 'xiaomi', model: 'mimo-v2.5-pro' }),
}));

vi.mock('../../../src/main/model/providers/providerResolution', () => ({
  resolveProviderApiKey: providerResolutionState.resolveProviderApiKey,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { parseVerdict, resolveReviewModelConfig, runReviewGate } from '../../../src/main/agent/goalReviewGate';
import type { ModelConfig } from '../../../src/shared/contract';

const parentModelConfig: ModelConfig = { provider: 'zhipu', model: 'glm-5' } as ModelConfig;

const deps = {
  workingDirectory: '/tmp/project',
  sessionId: 'session-1',
  parentModelConfig,
};

describe('resolveReviewModelConfig（可用性降级链）', () => {
  beforeEach(() => {
    providerResolutionState.resolveProviderApiKey.mockReset();
  });

  it('powerful tier 有可用 key → 用 powerful（强模型评审）', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');

    const config = resolveReviewModelConfig(parentModelConfig);

    expect(config.provider).toBe('xiaomi');
    expect(config.model).toBe('mimo-v2.5-pro');
  });

  it('powerful tier 无 key → 降级用主 run 的模型', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('');

    const config = resolveReviewModelConfig(parentModelConfig);

    expect(config.provider).toBe('zhipu');
    expect(config.model).toBe('glm-5');
  });

  it('powerful tier 无 key 且无主 run 模型 → 保持 powerful（原行为兜底）', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('');

    const config = resolveReviewModelConfig(undefined);

    expect(config.provider).toBe('xiaomi');
    expect(config.model).toBe('mimo-v2.5-pro');
  });

  it('key 可用性按子代理策略解析（trustConfigKey:false）', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-any');

    resolveReviewModelConfig(parentModelConfig);

    expect(providerResolutionState.resolveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'xiaomi' }),
      { trustConfigKey: false },
    );
  });
});

describe('runReviewGate（闸2 派发）', () => {
  beforeEach(() => {
    executorState.execute.mockReset();
    providerResolutionState.resolveProviderApiKey.mockReset();
  });

  it('powerful 无 key 时，评审子代理用主 run 模型派发', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('');
    executorState.execute.mockResolvedValue({
      success: true,
      output: '条件满足。\nVERDICT: PASS',
      iterations: 2,
      toolsUsed: ['read_file'],
    });

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(true);
    // 派发用的 modelConfig 是降级后的主 run 模型
    const [, , context] = executorState.execute.mock.calls[0];
    expect(context.modelConfig.provider).toBe('zhipu');
    expect(context.modelConfig.model).toBe('glm-5');
  });

  it('评审 FAIL → pass=false 且带理由', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    executorState.execute.mockResolvedValue({
      success: true,
      output: 'dup.py 三个函数体完全相同，明显重复。\nVERDICT: FAIL',
      iterations: 3,
      toolsUsed: ['read_file', 'grep'],
    });

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(false);
    expect(result.parsed).toBe(true);
    expect(result.reason).toContain('重复');
  });

  it('评审子代理抛错 → 默认 FAIL（不误放行）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    executorState.execute.mockRejectedValue(new Error('Invalid API Key'));

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(false);
    expect(result.parsed).toBe(false);
    expect(result.reason).toContain('Invalid API Key');
  });
});

describe('parseVerdict', () => {
  it('解析标准 VERDICT 行', () => {
    expect(parseVerdict('理由。\nVERDICT: PASS')).toEqual({ pass: true, parsed: true });
    expect(parseVerdict('理由。\nVERDICT: FAIL')).toEqual({ pass: false, parsed: true });
  });

  it('容忍 markdown 加粗与中文冒号，取最后一个 VERDICT', () => {
    expect(parseVerdict('格式说明 VERDICT: PASS 或 FAIL。\n**VERDICT：FAIL**')).toEqual({ pass: false, parsed: true });
  });

  it('无 VERDICT → parsed=false 默认 FAIL', () => {
    expect(parseVerdict('我觉得还行。')).toEqual({ pass: false, parsed: false });
  });
});
