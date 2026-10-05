import { describe, expect, it } from 'vitest';
import { applyEffortControls } from '../../../src/host/agent/runtime/contextAssembly/effortControls';
import { PROVIDER_REGISTRY } from '../../../src/host/model/providerRegistry';
import { SUPPORTED_AGENT_EFFORT_LEVELS } from '../../../src/shared/effortLevels';
import type { ModelConfig } from '../../../src/shared/contract/model';
import { GOLDEN_CASES, GOLDEN_MODELS } from './effortControls.golden';

const PRESETS = {
  none: {},
  reasoningEffort: { reasoningEffort: 'high' as const },
  thinkingBudget: { thinkingBudget: 32768 },
  both: { reasoningEffort: 'high' as const, thinkingBudget: 32768 },
} as const;

describe('applyEffortControls golden registry outputs', () => {
  it('matches the recorded output for every registry model, effort, thinking flag, and preset', () => {
    const models: string[] = [];
    for (const [providerId, provider] of Object.entries(PROVIDER_REGISTRY)) {
      for (const model of provider.models) {
        models.push(`${providerId}/${model.id}`);
      }
    }
    models.sort();
    expect(models).toEqual([...GOLDEN_MODELS]);

    for (const [providerId, provider] of Object.entries(PROVIDER_REGISTRY)) {
      for (const model of provider.models) {
        for (const effort of SUPPORTED_AGENT_EFFORT_LEVELS) {
          for (const thinkingEnabled of [true, false] as const) {
            for (const presetName of Object.keys(PRESETS) as Array<keyof typeof PRESETS>) {
              const config: ModelConfig = {
                provider: providerId,
                model: model.id,
                ...PRESETS[presetName],
              };
              const actual = applyEffortControls(config, effort, { thinkingEnabled });
              const recorded = GOLDEN_CASES[`${effort}|${thinkingEnabled}|${presetName}`];
              expect(actual).toEqual({
                provider: providerId,
                model: model.id,
                thinkingBudget: recorded.thinkingBudget,
                reasoningEffort: recorded.reasoningEffort,
              });
            }
          }
        }
      }
    }
  });
});
