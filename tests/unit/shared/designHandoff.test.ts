import { describe, expect, it } from 'vitest';
import {
  deserializeDesignCodeHandoffContext,
  formatDesignCodeHandoffForPrompt,
  normalizeDesignCodeHandoffContext,
  serializeDesignCodeHandoffContext,
} from '../../../src/shared/contract/designHandoff';

describe('designHandoff', () => {
  it('normalizes Design->Code B model handoff context with selected variant and contract', () => {
    const context = normalizeDesignCodeHandoffContext({
      mode: 'anything_else',
      codeVisibility: 'visible',
      userSuccessSignal: 'source_export',
      selectedVariants: [
        {
          id: 'hero-v2',
          label: 'Interactive checkout hero',
          sourcePath: '/tmp/design/assets/hero.png',
          mediaType: 'image',
          chosen: true,
          bounds: { x: 120, y: 48, width: 720, height: 420 },
          interactionStates: [
            {
              id: 'confirm',
              description: 'Click Confirm and show the confirmed state.',
              selector: '#confirm',
              trigger: 'click',
              expectedState: '#state text becomes Confirmed',
            },
          ],
        },
      ],
      acceptanceContract: {
        acceptanceCriteria: ['Confirm state must work after handoff.'],
        lockedRegions: [
          {
            nodeId: 'hero-v2',
            preserve: ['layout', 'interaction'],
            lockMode: 'strict',
          },
        ],
        brandRefs: [{ name: 'Neo', source: 'manual', notes: ['Use blue primary action.'] }],
      },
      previewQa: {
        deterministicPassed: true,
        visionPassed: true,
        repairAttempts: 1,
        finalFindingCount: 0,
        checks: ['Preview QA passed after repair.'],
      },
    });

    expect(context).toMatchObject({
      version: 1,
      mode: 'design_to_code_b',
      codeVisibility: 'hidden',
      userSuccessSignal: 'running_artifact',
      selectedVariants: [
        {
          id: 'hero-v2',
          chosen: true,
          bounds: { x: 120, y: 48, width: 720, height: 420, coordinateSpace: 'canvas_absolute' },
        },
      ],
      previewQa: {
        deterministicPassed: true,
        visionPassed: true,
        repairAttempts: 1,
        finalFindingCount: 0,
      },
    });
    expect(context?.acceptanceContract?.lockedRegions[0]?.regionLock.strict).toBe(true);
  });

  it('round-trips through serialization and formats hidden prompt JSON', () => {
    const serialized = serializeDesignCodeHandoffContext({
      selectedVariants: [
        {
          id: 'card',
          mediaType: 'image',
          bounds: { x: 0, y: 0, width: 320, height: 180 },
        },
      ],
      notes: ['Code remains invisible to the user.'],
    });

    expect(serialized).toBeTruthy();
    const parsed = deserializeDesignCodeHandoffContext(serialized!);
    expect(parsed).toEqual(normalizeDesignCodeHandoffContext(JSON.parse(serialized!)));

    const prompt = formatDesignCodeHandoffForPrompt(parsed);
    expect(prompt).toContain('"mode": "design_to_code_b"');
    expect(prompt).toContain('"codeVisibility": "hidden"');
    expect(prompt).toContain('"userSuccessSignal": "running_artifact"');
  });

  it('drops invalid handoff payloads with no selected runnable design variant', () => {
    expect(normalizeDesignCodeHandoffContext({})).toBeUndefined();
    expect(normalizeDesignCodeHandoffContext({
      selectedVariants: [{ id: 'broken', bounds: { x: 0, y: 0, width: 0, height: 100 } }],
    })).toBeUndefined();
    expect(deserializeDesignCodeHandoffContext('{bad json')).toBeUndefined();
  });
});
