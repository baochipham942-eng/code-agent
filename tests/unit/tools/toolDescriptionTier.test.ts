import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getAllToolDefinitions } from '../../../src/host/tools/dispatch/toolDefinitions';
import { taskManagerSchema } from '../../../src/host/tools/modules/planning/taskManager.schema';

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function taskManagerDescription(ctx?: { provider?: string; model?: string }): string {
  const definition = getAllToolDefinitions(ctx)
    .find((candidate) => candidate.name === 'TaskManager');
  if (!definition) throw new Error('TaskManager definition is missing');
  return definition.description;
}

describe('TaskManager model-tier description', () => {
  const shortDescription = taskManagerDescription({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
  });
  const longDescription = taskManagerSchema.description;

  beforeEach(() => {
    resetProtocolRegistry();
  });

  it.each([
    { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' },
  ])('uses the short description for Claude family: $provider/$model', (ctx) => {
    expect(taskManagerDescription(ctx)).toBe(shortDescription);
  });

  it('keeps the current long description for DeepSeek and the context-free fallback', () => {
    expect(taskManagerDescription({ provider: 'deepseek', model: 'deepseek-v4-flash' }))
      .toBe(longDescription);
    expect(taskManagerDescription()).toBe(longDescription);
  });

  it.each([
    ['short', shortDescription],
    ['long', longDescription],
  ])('keeps the evidence gate in the %s description', (_tier, description) => {
    expect(description).toContain('completionEvidence');
    expect(description).toContain('blockedReason');
  });

  it('uses fewer real tokenizer tokens for the short description', () => {
    const shortTokens = estimateTokens(shortDescription);
    const longTokens = estimateTokens(longDescription);

    // Measured with the production token estimator: short 388 / long 889 tokens.
    expect(shortTokens).toBeLessThan(longTokens);
  });
});

describe('tool schema telemetry version', () => {
  it('changes when the tool-description tier rule version changes', async () => {
    vi.resetModules();
    vi.doMock('../../../src/host/telemetry/toolDescriptionTierRuleVersion', () => ({
      TOOL_DESCRIPTION_TIER_RULE_VERSION: 'tier-v1',
    }));
    const tierV1 = await import('../../../src/host/telemetry/diagnosticVersions');
    tierV1.resetToolSchemaVersionCache();
    const versionV1 = tierV1.getToolSchemaVersion();

    vi.resetModules();
    vi.doMock('../../../src/host/telemetry/toolDescriptionTierRuleVersion', () => ({
      TOOL_DESCRIPTION_TIER_RULE_VERSION: 'tier-v2',
    }));
    const tierV2 = await import('../../../src/host/telemetry/diagnosticVersions');
    tierV2.resetToolSchemaVersionCache();
    const versionV2 = tierV2.getToolSchemaVersion();

    expect(versionV2).not.toBe(versionV1);
    vi.doUnmock('../../../src/host/telemetry/toolDescriptionTierRuleVersion');
  });
});
