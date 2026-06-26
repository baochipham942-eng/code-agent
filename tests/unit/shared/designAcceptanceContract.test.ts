import { describe, expect, it } from 'vitest';
import { directionTokens } from '../../../src/design/direction-tokens';
import {
  deserializeDesignAcceptanceContract,
  designAcceptanceBrandRefFromBrandContract,
  formatDesignAcceptanceContractForPrompt,
  normalizeDesignAcceptanceContract,
  serializeDesignAcceptanceContract,
} from '../../../src/shared/contract/designAcceptanceContract';
import type { BrandContract } from '../../../src/shared/contract/brandContract';
import { REGION_LOCK } from '../../../src/shared/constants/designWorkspace';

const brand: BrandContract = {
  id: 'neo-brand',
  name: 'Neo Brand',
  tokens: directionTokens.technical,
  keep: ['dense layout'],
  change: ['accent can vary'],
  doNotCopy: ['no gradient blobs'],
  logoPath: '/tmp/logo.png',
  source: 'manual',
  createdAt: 1,
  updatedAt: 2,
};

describe('designAcceptanceContract', () => {
  it('normalizes acceptance criteria, locked regions and brand refs', () => {
    const contract = normalizeDesignAcceptanceContract({
      source: 'handoff',
      acceptanceCriteria: [
        '  Primary CTA is usable  ',
        { id: 'cta', text: 'Primary CTA is usable', priority: 'must', source: 'user' },
        { text: 'Responsive mobile layout holds', priority: 'should', source: 'qa' },
      ],
      lockedRegions: [
        {
          nodeId: 'hero',
          label: 'Hero',
          reason: 'User selected this variant',
          preserve: ['layout', 'visual', 'visual'],
          lockMode: 'strict',
        },
      ],
      brandRefs: [
        {
          id: 'brand-a',
          name: 'Brand A',
          source: 'manual',
          tokens: directionTokens.calm,
          contract: {
            keep: ['quiet typography'],
            change: [],
            doNotCopy: ['emoji'],
          },
        },
      ],
    });

    expect(contract).toMatchObject({
      version: 1,
      intent: 'agent_convergence',
      source: 'handoff',
      acceptanceCriteria: [
        { id: 'acceptance-1', text: 'Primary CTA is usable', priority: 'must', source: 'user' },
        { id: 'acceptance-3', text: 'Responsive mobile layout holds', priority: 'should', source: 'qa' },
      ],
      lockedRegions: [
        {
          id: 'hero',
          nodeId: 'hero',
          preserve: ['layout', 'visual'],
          lockMode: 'strict',
          regionLock: { epsilon: REGION_LOCK.EPSILON, strict: true },
        },
      ],
    });
    expect(contract?.brandRefs[0].tokens).toEqual(directionTokens.calm);
    expect(contract?.brandRefs[0].contract?.doNotCopy).toEqual(['emoji']);
  });

  it('round-trips through serialize and deserialize', () => {
    const serialized = serializeDesignAcceptanceContract({
      acceptanceCriteria: [{ id: 'done', text: 'Runs without user touching code', priority: 'must' }],
      lockedRegions: [{ bounds: { x: 10, y: 20, width: 300, height: 120 }, preserve: ['content'] }],
      brandRefs: [designAcceptanceBrandRefFromBrandContract(brand)],
      notes: ['Use this as agent intent, not developer-facing spec'],
    });

    expect(serialized).toBeTruthy();
    const parsed = deserializeDesignAcceptanceContract(serialized!);
    expect(parsed).toEqual(normalizeDesignAcceptanceContract(JSON.parse(serialized!)));
    expect(parsed?.brandRefs[0]).toMatchObject({
      id: 'neo-brand',
      name: 'Neo Brand',
      source: 'active_brand',
      contract: {
        keep: ['dense layout'],
        change: ['accent can vary'],
        doNotCopy: ['no gradient blobs'],
        logoPath: '/tmp/logo.png',
      },
    });
  });

  it('drops empty or invalid contracts', () => {
    expect(normalizeDesignAcceptanceContract({})).toBeUndefined();
    expect(normalizeDesignAcceptanceContract({
      acceptanceCriteria: ['  '],
      lockedRegions: [{ label: 'missing target' }],
      brandRefs: [{}],
    })).toBeUndefined();
    expect(deserializeDesignAcceptanceContract('{bad json')).toBeUndefined();
  });

  it('formats prompt JSON with the agent convergence intent', () => {
    const payload = formatDesignAcceptanceContractForPrompt({
      acceptanceCriteria: ['Preview QA passes with zero deterministic findings'],
    });

    expect(payload).toContain('"intent": "agent_convergence"');
    expect(payload).toContain('Preview QA passes with zero deterministic findings');
  });
});
