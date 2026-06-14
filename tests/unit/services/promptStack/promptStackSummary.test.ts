import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION } from '../../../../src/shared/constants/agent';
import { DYNAMIC_BOUNDARY_MARKER } from '../../../../src/main/prompts/cacheBreakDetection';
import { summarizePromptStack } from '../../../../src/main/services/promptStack/promptStackSummary';

describe('summarizePromptStack', () => {
  it('summarizes stable and dynamic prompt layers without exposing full text fields', () => {
    const prompt = [
      'You are Agent Neo\n\n<project_profile>\nProject rules\n</project_profile>',
      '## Tools\nSkill tool guidance\nSkills are product capabilities',
      '## Tool Call Envelope\n_meta rules',
      DYNAMIC_BOUNDARY_MARKER,
      '<role_assets role="researcher">memory index</role_assets>',
    ].join('\n\n');

    const summary = summarizePromptStack(prompt);

    expect(summary.promptVersion).toBe(PROMPT_VERSION);
    expect(summary.hasDynamicBoundary).toBe(true);
    expect(summary.totalChars).toBe(prompt.length);
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.detectedCapabilities).toContain('Stable substrate');
    expect(summary.detectedCapabilities).toContain('Tool catalog');
    expect(summary.detectedCapabilities).toContain('Skill guidance');
    expect(summary.layers.find((layer) => layer.id === 'role-assets')).toMatchObject({
      present: true,
    });
    expect(summary.layers.find((layer) => layer.id === 'project-profile')).toMatchObject({
      present: true,
    });
    expect(summary.layers.find((layer) => layer.id === 'role-assets')?.chars).toBeLessThan(prompt.length);
    expect(summary.layers.find((layer) => layer.id === 'project-profile')?.chars).toBeLessThan(prompt.length);
    expect(JSON.stringify(summary)).not.toContain('memory index');
    expect(JSON.stringify(summary)).not.toContain('Project rules');
  });

  it('warns when there is no dynamic boundary or skill guidance', () => {
    const summary = summarizePromptStack('You are Agent Neo\n\n## Tools\nRead files');

    expect(summary.hasDynamicBoundary).toBe(false);
    expect(summary.warnings).toContain('No dynamic boundary found; prompt cache attribution may be less granular.');
    expect(summary.warnings).toContain('No skill guidance detected in the current prompt text.');
  });
});
