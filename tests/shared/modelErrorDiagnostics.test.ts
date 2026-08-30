import { describe, expect, it } from 'vitest';
import { classifyModelErrorMessage, summarizeModelErrorForUser } from '../../src/shared/modelErrorDiagnostics';

const RAW_TEMPERATURE_AND_FALLBACK_ERROR = [
  "litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0.7 with this model.",
  'Only the default (1) value is supported.',
  'No fallback model group found for original model_group=gpt-5.5.',
  "Fallbacks=[{'gpt-5.4': ['gpt-5.5']}, {'deepseek-v4-pro': ['qwen3.7-max']}]",
].join(' ');

describe('model error diagnostics', () => {
  it('turns unsupported temperature errors into a short actionable message', () => {
    const diagnostic = classifyModelErrorMessage(RAW_TEMPERATURE_AND_FALLBACK_ERROR);

    expect(diagnostic).toMatchObject({
      code: 'unsupported_temperature',
      retryable: true,
      hasFallbackConfigurationIssue: true,
    });
    expect(diagnostic?.message).toContain('默认温度 1');
    expect(diagnostic?.suggestion).toContain('fallback');
  });

  it('does not leak raw LiteLLM fallback internals in the user summary', () => {
    const summary = summarizeModelErrorForUser(RAW_TEMPERATURE_AND_FALLBACK_ERROR);

    expect(summary).toContain('模型参数不兼容');
    expect(summary).not.toContain('litellm.BadRequestError');
    expect(summary).not.toContain("Fallbacks=[{'gpt-5.4'");
  });

  it('classifies fallback-only routing errors', () => {
    expect(classifyModelErrorMessage('No fallback model group found for original model_group=gpt-5.5')).toMatchObject({
      code: 'fallback_not_configured',
      retryable: false,
    });
  });
});

describe('auth_failed / quota_exhausted（2026-08-30 欠费卡死批）', () => {
  it('401/403 状态码直接判鉴权失败，不可重试，给配置建议', () => {
    for (const statusCode of [401, 403]) {
      const diagnostic = classifyModelErrorMessage('upstream rejected the request', statusCode);
      expect(diagnostic).toMatchObject({ code: 'auth_failed', retryable: false });
      expect(diagnostic?.suggestion).toContain('/login');
      expect(diagnostic?.suggestion).toContain('/model');
    }
  });

  it('鉴权文案（含中文）无状态码也判 auth_failed', () => {
    expect(classifyModelErrorMessage('invalid_api_key')).toMatchObject({ code: 'auth_failed' });
    expect(classifyModelErrorMessage('鉴权失败，请检查密钥')).toMatchObject({ code: 'auth_failed' });
  });

  it('402 与欠费/余额文案判 quota_exhausted，不可重试', () => {
    expect(classifyModelErrorMessage('rejected', 402)).toMatchObject({ code: 'quota_exhausted', retryable: false });
    expect(classifyModelErrorMessage('insufficient_quota')).toMatchObject({ code: 'quota_exhausted' });
    expect(classifyModelErrorMessage('账户已欠费，请充值')).toMatchObject({ code: 'quota_exhausted' });
    expect(classifyModelErrorMessage('余额不足')).toMatchObject({ code: 'quota_exhausted' });
  });

  it('summarizeModelErrorForUser 输出人话 + 建议，不透出原始内部文案', () => {
    const summary = summarizeModelErrorForUser('Error: 欠费 (status 402)', 402);
    expect(summary).toContain('余额或配额不足');
    expect(summary).toContain('建议：');
    expect(summary).not.toContain('Native Durable Run');
  });

  it('裸 429 限流不算欠费（quota 语义只认文案/402）', () => {
    expect(classifyModelErrorMessage('rate limit exceeded', 429)).toBeNull();
  });
});
