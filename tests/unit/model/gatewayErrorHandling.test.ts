// ============================================================================
// 网关类错误（502/503/504/429）的重试与人话降级 —— 2026-07-23 真机事故回归钉
// ----------------------------------------------------------------------------
// 实测：智谱 GLM-5 上游 502，用户界面上只有一行英文 `Error: Bad Gateway`，而且一次没重试。
// 两处都做过、但都只认数字形态：
//   - TRANSIENT_PATTERNS 里有 '502'，可 AI SDK 的 APICallError.message 字面就是 'Bad Gateway'
//   - classifyModelErrorMessage 只认「温度不兼容」「fallback 未配置」两类
// ============================================================================

import { describe, expect, it } from 'vitest';
import { isTransientError } from '../../../src/host/model/providers/retryStrategy';
import {
  classifyModelErrorMessage,
  summarizeModelErrorForUser,
} from '../../../src/shared/modelErrorDiagnostics';

describe('网关类错误按瞬态处理（只给文案、不给数字也要认）', () => {
  it.each([
    'Bad Gateway',
    'Service Unavailable',
    'Gateway Timeout',
  ])('「%s」判为瞬态，可重试', (message) => {
    expect(isTransientError(message)).toBe(true);
  });

  it('数字形态仍然认（别把老路径改坏）', () => {
    expect(isTransientError('HTTP 502 upstream failed')).toBe(true);
    expect(isTransientError('socket hang up')).toBe(true);
  });

  it('真正不该重试的仍然不重试（防一刀切放宽）', () => {
    expect(isTransientError('invalid api key')).toBe(false);
    expect(isTransientError('context length exceeded')).toBe(false);
  });

  it('配额族不归网关：429 有独立的 quota 语义，误收会让用户以为重试能好', () => {
    expect(classifyModelErrorMessage('Too Many Requests')?.code).not.toBe('upstream_unavailable');
    expect(classifyModelErrorMessage('429 rate limited')?.code).not.toBe('upstream_unavailable');
  });
});

describe('网关类错误给人话而不是甩英文', () => {
  it('Bad Gateway 归类成 upstream_unavailable 且标可重试', () => {
    const diagnostic = classifyModelErrorMessage('Bad Gateway');
    expect(diagnostic?.code).toBe('upstream_unavailable');
    expect(diagnostic?.retryable).toBe(true);
  });

  it('给用户的文案是中文，并给出重试或换模型的出路', () => {
    const summary = summarizeModelErrorForUser('Bad Gateway');
    // 先确认真的产出了内容，避免空串让下面的断言天然通过
    expect(summary.length).toBeGreaterThan(10);
    expect(summary).toContain('模型服务暂时不可用');
    expect(summary).toContain('换一个模型');
    // 不再把裸英文当作全部内容甩出去
    expect(summary).not.toBe('Bad Gateway');
  });

  it('既有两类分类不受影响', () => {
    expect(classifyModelErrorMessage("Unsupported value: 'temperature'")?.code)
      .toBe('unsupported_temperature');
    expect(classifyModelErrorMessage('no fallback model group found')?.code)
      .toBe('fallback_not_configured');
  });

  it('无法归类的错误仍原样透传（不许假装认识）', () => {
    expect(summarizeModelErrorForUser('some brand new failure')).toBe('some brand new failure');
  });
});
