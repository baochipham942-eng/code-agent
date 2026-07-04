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

const healthMonitorState = vi.hoisted(() => ({
  healthMap: new Map<string, { status: string }>(),
}));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => executorState,
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({}),
}));

// powerful tier 固定模拟成生产默认（xiaomi/mimo）
vi.mock('../../../src/host/agent/hybrid/coreAgents', () => ({
  getModelConfig: () => ({ provider: 'xiaomi', model: 'mimo-v2.5-pro' }),
}));

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderApiKey: providerResolutionState.resolveProviderApiKey,
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({
    getHealthMap: () => healthMonitorState.healthMap,
    getHealth: (provider: string) => healthMonitorState.healthMap.get(provider) ?? null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { parseVerdict, resolveReviewModelConfig, runReviewGate, REVIEW_SYSTEM_PROMPT } from '../../../src/host/agent/goalReviewGate';
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
    healthMonitorState.healthMap = new Map();
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

  it('powerful 有 key 但健康监视器判 unavailable（key 配了但已失效）→ 直接降级主 run 模型', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    healthMonitorState.healthMap = new Map([['xiaomi', { status: 'unavailable' }]]);

    const config = resolveReviewModelConfig(parentModelConfig);

    expect(config.provider).toBe('zhipu');
    expect(config.model).toBe('glm-5');
  });

  it('健康监视器键与 provider id 大小写不一致（retryStrategy 路径用显示名）→ 仍命中', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    healthMonitorState.healthMap = new Map([['Xiaomi', { status: 'unavailable' }]]);

    const config = resolveReviewModelConfig(parentModelConfig);

    expect(config.provider).toBe('zhipu');
  });

  it('健康信号缺失（monitor 无该 provider 记录）→ fail-open 保持现行为用 powerful', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    healthMonitorState.healthMap = new Map();

    const config = resolveReviewModelConfig(parentModelConfig);

    expect(config.provider).toBe('xiaomi');
  });

  it('健康状态仅 degraded（未到 unavailable）→ 保留 powerful（不轻易放弃强模型评审）', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    healthMonitorState.healthMap = new Map([['xiaomi', { status: 'degraded' }]]);

    const config = resolveReviewModelConfig(parentModelConfig);

    expect(config.provider).toBe('xiaomi');
  });

  it('unavailable 但无主 run 模型可降 → 保持 powerful（原兜底行为）', () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    healthMonitorState.healthMap = new Map([['xiaomi', { status: 'unavailable' }]]);

    const config = resolveReviewModelConfig(undefined);

    expect(config.provider).toBe('xiaomi');
  });
});

describe('runReviewGate（闸2 派发）', () => {
  beforeEach(() => {
    executorState.execute.mockReset();
    providerResolutionState.resolveProviderApiKey.mockReset();
    healthMonitorState.healthMap = new Map();
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

  it('评审子代理抛非 infra 类错误 → 默认 FAIL（不误放行，不触发降级重试）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    executorState.execute.mockRejectedValue(new Error('unexpected internal state'));

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(false);
    expect(result.parsed).toBe(false);
    expect(result.unverifiable).toBeUndefined();
    expect(result.reason).toContain('unexpected internal state');
    expect(executorState.execute).toHaveBeenCalledTimes(1);
  });
});

describe('runReviewGate（infra 故障降级链：auth/4xx 不许伪装成评审不过）', () => {
  beforeEach(() => {
    executorState.execute.mockReset();
    providerResolutionState.resolveProviderApiKey.mockReset();
    healthMonitorState.healthMap = new Map();
  });

  it('powerful 撞 auth 错（key 配了但 401）→ 用主 run 模型降级重试一次，重试成功则评审结果照常生效', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    executorState.execute
      .mockRejectedValueOnce(new Error('Invalid API Key'))
      .mockResolvedValueOnce({
        success: true,
        output: '条件满足，证据充分。\nVERDICT: PASS',
        iterations: 2,
        toolsUsed: ['read_file'],
      });

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(true);
    expect(result.parsed).toBe(true);
    expect(result.unverifiable).toBeUndefined();
    expect(executorState.execute).toHaveBeenCalledTimes(2);
    // 第二次派发用的是主 run 模型
    const [, , retryContext] = executorState.execute.mock.calls[1];
    expect(retryContext.modelConfig.provider).toBe('zhipu');
    expect(retryContext.modelConfig.model).toBe('glm-5');
  });

  it('降级重试后评审 FAIL → 结果照常生效（真评审结论不受降级影响）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    executorState.execute
      .mockRejectedValueOnce(new Error('401 authentication_error'))
      .mockResolvedValueOnce({
        success: true,
        output: '仍有重复逻辑。\nVERDICT: FAIL',
        iterations: 3,
        toolsUsed: ['grep'],
      });

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(false);
    expect(result.parsed).toBe(true);
    expect(result.unverifiable).toBeUndefined();
  });

  it('双模型都 infra 失败 → unverifiable（不许按评审 FAIL 处理），reason 带真实错误', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    executorState.execute
      .mockRejectedValueOnce(new Error('Invalid API Key'))
      .mockRejectedValueOnce(new Error('401 Unauthorized'));

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(false);
    expect(result.parsed).toBe(false);
    expect(result.unverifiable).toBe(true);
    expect(result.reason).toContain('401 Unauthorized');
    expect(executorState.execute).toHaveBeenCalledTimes(2);
  });

  it('评审模型已经等于主 run 模型（powerful 无 key 已降级）→ infra 错不再重试，直接 unverifiable', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('');
    executorState.execute.mockRejectedValue(new Error('insufficient_quota'));

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.unverifiable).toBe(true);
    expect(result.pass).toBe(false);
    expect(executorState.execute).toHaveBeenCalledTimes(1);
  });

  it('无主 run 模型可降级 → infra 错直接 unverifiable（不重试同一个必败模型）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    executorState.execute.mockRejectedValue(new Error('Invalid API Key'));

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', {
      workingDirectory: '/tmp/project',
      sessionId: 'session-1',
    });

    expect(result.unverifiable).toBe(true);
    expect(executorState.execute).toHaveBeenCalledTimes(1);
  });

  it('子代理 success=false 且 error 为 auth 类（非取消）→ 同样走降级重试链', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-expired');
    executorState.execute
      .mockResolvedValueOnce({ success: false, output: '', error: 'authentication_error: invalid key', iterations: 0, toolsUsed: [] })
      .mockResolvedValueOnce({
        success: true,
        output: '条件满足。\nVERDICT: PASS',
        iterations: 2,
        toolsUsed: ['read_file'],
      });

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(true);
    expect(result.unverifiable).toBeUndefined();
    expect(executorState.execute).toHaveBeenCalledTimes(2);
  });

  it('错误消息里数字撞车（如 4013ms 含 "401"）→ 不算 infra，默认 FAIL 不重试（词边界匹配）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    executorState.execute.mockRejectedValue(new Error('Request failed after 4013ms'));

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.unverifiable).toBeUndefined();
    expect(result.pass).toBe(false);
    expect(executorState.execute).toHaveBeenCalledTimes(1);
  });

  it('AbortError 抛错（即使消息碰巧含 infra 词，如 forbidden）→ 不算 infra、不重试（对称 cancellationReason 过滤）', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    const abortErr = new Error('request forbidden by abort signal');
    abortErr.name = 'AbortError';
    executorState.execute.mockRejectedValue(abortErr);

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.unverifiable).toBeUndefined();
    expect(result.pass).toBe(false);
    expect(executorState.execute).toHaveBeenCalledTimes(1);
  });

  it('子代理被取消（cancellationReason）→ 保持默认 FAIL，不算 infra、不重试', async () => {
    providerResolutionState.resolveProviderApiKey.mockReturnValue('sk-xiaomi-valid');
    executorState.execute.mockResolvedValue({
      success: false,
      output: '',
      cancellationReason: 'aborted',
      iterations: 1,
      toolsUsed: [],
    });

    const result = await runReviewGate('代码无重复逻辑', '重构 utils', deps);

    expect(result.pass).toBe(false);
    expect(result.unverifiable).toBeUndefined();
    expect(executorState.execute).toHaveBeenCalledTimes(1);
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

  it('解析 IMPOSSIBLE 裁决（目标不可达主动止损，roadmap 1.4）', () => {
    expect(parseVerdict('条件自相矛盾，本会话内不可能达成。\nVERDICT: IMPOSSIBLE')).toEqual({
      pass: false,
      parsed: true,
      impossible: true,
    });
  });

  it('IMPOSSIBLE 同样取最后一个 VERDICT', () => {
    expect(parseVerdict('VERDICT: PASS 是格式示例。\nVERDICT: IMPOSSIBLE')).toEqual({
      pass: false,
      parsed: true,
      impossible: true,
    });
  });
});

describe('REVIEW_SYSTEM_PROMPT 防欺骗三件套 (roadmap 1.4)', () => {
  it('包含：引用原文证据 / 自称不可达是证据不是证明 / 无证据默认 FAIL / IMPOSSIBLE 出口', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('逐字引用');
    expect(REVIEW_SYSTEM_PROMPT).toContain('证据不是证明');
    expect(REVIEW_SYSTEM_PROMPT).toContain('证据不足');
    expect(REVIEW_SYSTEM_PROMPT).toContain('VERDICT: IMPOSSIBLE');
  });
});
