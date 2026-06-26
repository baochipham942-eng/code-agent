import { describe, it, expect, beforeEach, vi } from 'vitest';

import { gameSubtypeRegistry } from '../../../../../src/host/agent/runtime/game/registry';
import type {
  GameSubtypeChecker,
  MechanicsResult,
  RuntimeEvidenceResult,
} from '../../../../../src/host/agent/runtime/game/types';

function makeChecker(subtype: string): GameSubtypeChecker {
  return {
    subtype,
    declaredVerbs: [],
    validateMechanics(): MechanicsResult {
      return { passed: true, failures: [], checks: [] };
    },
    validateRuntimeEvidence(): RuntimeEvidenceResult {
      return { passed: true, failures: [], checks: [] };
    },
    repairGuidance(): string | undefined {
      return undefined;
    },
  };
}

describe('gameSubtypeRegistry', () => {
  beforeEach(() => {
    gameSubtypeRegistry.clear();
  });

  it('registers and retrieves a checker', () => {
    const checker = makeChecker('platformer');
    gameSubtypeRegistry.register(checker);
    expect(gameSubtypeRegistry.get('platformer')).toBe(checker);
  });

  it('returns undefined for unknown subtype', () => {
    expect(gameSubtypeRegistry.get('runner')).toBeUndefined();
  });

  it('list() returns sorted subtypes', () => {
    gameSubtypeRegistry.register(makeChecker('runner'));
    gameSubtypeRegistry.register(makeChecker('platformer'));
    gameSubtypeRegistry.register(makeChecker('tower-defense'));
    expect(gameSubtypeRegistry.list()).toEqual([
      'platformer',
      'runner',
      'tower-defense',
    ]);
  });

  it('warns on duplicate registration but overwrites', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeChecker('platformer');
    const second = makeChecker('platformer');
    gameSubtypeRegistry.register(first);
    gameSubtypeRegistry.register(second);
    expect(gameSubtypeRegistry.get('platformer')).toBe(second);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('already registered'),
    );
    warn.mockRestore();
  });

  it('clear() drops all entries', () => {
    gameSubtypeRegistry.register(makeChecker('platformer'));
    gameSubtypeRegistry.clear();
    expect(gameSubtypeRegistry.list()).toEqual([]);
  });
});
