import { describe, expect, it } from 'vitest';
import {
  buildAgentEngineFailureMetadata,
  classifyAgentEngineFailure,
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

    const metadata = buildAgentEngineFailureMetadata(failure);
    expect(metadata).toMatchObject({ category: 'generic', timestamp: 123 });
    expect(metadata.rawMessage).toContain('默认温度 1');
    expect(metadata.rawMessage).not.toContain('/tmp/claude.log');
    expect(metadata.rawMessage).not.toContain('litellm.BadRequestError');
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

  it('keeps absolute binary paths out of the user-facing failure card metadata', () => {
    const failure = classifyAgentEngineFailure({
      engine: 'kimi_code_acp',
      message: 'Command failed: /Users/example/.npm-global/bin/kimi --version',
      occurredAt: 456,
    });

    const metadata = buildAgentEngineFailureMetadata(failure);

    expect(metadata.rawMessage).not.toContain('/Users/example');
    expect(metadata.rawMessage).not.toContain('--version');
    expect(metadata).toMatchObject({ category: 'generic', timestamp: 456 });
  });
});
