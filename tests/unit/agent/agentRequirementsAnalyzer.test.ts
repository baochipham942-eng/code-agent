import { describe, expect, it } from 'vitest';
import { AgentRequirementsAnalyzer } from '../../../src/host/agent/agentRequirementsAnalyzer';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

describe('AgentRequirementsAnalyzer bounded comparisons', () => {
  it.each([
    ['zh', zh.chat.suggestions.competitorBrief.prompt],
    ['en', en.chat.suggestions.competitorBrief.prompt],
  ])('%s competitor starter stays in the normal loop', async (_language, prompt) => {
    const requirements = await new AgentRequirementsAnalyzer().analyze(prompt);

    expect(requirements.needsAutoAgent).toBe(false);
  });

  it('keeps auto-agent dispatch for an explicitly large multi-dimension comparison', async () => {
    const requirements = await new AgentRequirementsAnalyzer().analyze(
      'Compare 12 vendors across security, performance, quality, frontend, backend, database, and API dimensions. Produce a comprehensive report with independent findings, a complete recommendation, and a rollout plan. Validate sources, explain tradeoffs, and identify the highest-risk gaps for each vendor.',
    );

    expect(requirements.needsAutoAgent).toBe(true);
  });
});
