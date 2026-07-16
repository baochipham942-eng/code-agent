import { describe, expect, it } from 'vitest';
import {
  redactCredentialText,
  secretPatternRegistry,
} from '../../../src/shared/security/secretPatterns';
import { secretPatternCanaries } from './secretPatternCanaries';

describe('secret pattern tripwire', () => {
  it('keeps canaries in lockstep with the shared registry', () => {
    const patternIds = secretPatternRegistry.map((entry) => entry.id).sort();
    const canaryIds = secretPatternCanaries.map((entry) => entry.id).sort();

    expect(patternIds).toEqual(canaryIds);
  });

  it('redacts each positive canary and leaves each negative canary unchanged', () => {
    for (const canary of secretPatternCanaries) {
      const redacted = redactCredentialText(canary.positive);
      expect(redacted, canary.id).not.toContain(canary.rawSecret);
      expect(redacted, canary.id).not.toBe(canary.positive);
      expect(redactCredentialText(canary.negative), canary.id).toBe(canary.negative);
    }
  });
});
