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
