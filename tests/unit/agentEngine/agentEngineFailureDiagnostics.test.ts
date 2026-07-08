import { describe, expect, it } from 'vitest';
import {
  classifyAgentEngineFailure,
  formatAgentEngineFailureContent,
} from '../../../src/host/services/agentEngine/agentEngineFailureDiagnostics';

describe('agent engine failure diagnostics', () => {
  it('classifies model parameter incompatibility as model_config and hides raw relay internals', () => {
    const failure = classifyAgentEngineFailure({
      engine: 'claude_code',
      message: "litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.No fallback model group found for original model_group=gpt-5.5.",
      exitCode: 1,
      occurredAt: 123,
    });

    expect(failure).toMatchObject({
      category: 'model_config',
      reason: 'unsupported_temperature',
      retryable: true,
      occurredAt: 123,
      exitCode: 1,
    });

    const content = formatAgentEngineFailureContent('Claude Code', failure, '/tmp/claude.log');
    expect(content).toContain('模型参数不兼容');
    expect(content).toContain('默认温度 1');
    expect(content).toContain('日志：/tmp/claude.log');
    expect(content).not.toContain('litellm.BadRequestError');
  });

  it('classifies missing fallback configuration separately', () => {
    const failure = classifyAgentEngineFailure({
      engine: 'codex_cli',
      message: 'No fallback model group found for original model_group=gpt-5.5. Model Group Fallbacks=None',
    });

    expect(failure).toMatchObject({
      category: 'model_config',
      reason: 'fallback_not_configured',
      retryable: false,
    });
  });
});
