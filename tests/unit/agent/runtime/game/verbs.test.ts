import { describe, it, expect } from 'vitest';

import {
  VERB_REGISTRY,
  evaluatePredicate,
  evaluatePredicateWithReason,
  extractByPath,
  getVerbMetadata,
} from '../../../../../src/main/agent/runtime/game/verbs';
import type { PredicateExpr, VerbId } from '../../../../../src/main/agent/runtime/game/types';

describe('extractByPath', () => {
  it('extracts dotted path', () => {
    expect(extractByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('extracts array index path', () => {
    expect(
      extractByPath({ enemies: [{ dead: true }, { dead: false }] }, 'enemies[0].dead'),
    ).toBe(true);
  });

  it('returns undefined for missing path', () => {
    expect(extractByPath({ a: 1 }, 'a.missing.deep')).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(extractByPath(undefined, 'a')).toBeUndefined();
    expect(extractByPath(null, 'a')).toBeUndefined();
  });

  it('handles abilities-style nested path', () => {
    const snap = { player: { abilities: { doubleJump: true } } };
    expect(extractByPath(snap, 'player.abilities.doubleJump')).toBe(true);
  });

  it('returns the input when path is empty', () => {
    expect(extractByPath({ x: 1 }, '')).toEqual({ x: 1 });
  });

  it('returns undefined for malformed bracket path', () => {
    expect(extractByPath({ a: [1] }, 'a[0')).toBeUndefined();
    expect(extractByPath({ a: [1] }, 'a[]')).toBeUndefined();
  });

  it('supports chained array indexes', () => {
    expect(extractByPath({ grid: [[10, 20], [30, 40]] }, 'grid[1][0]')).toBe(30);
  });

  it('reads array length via dotted path', () => {
    expect(extractByPath({ inventory: ['k1', 'k2', 'k3'] }, 'inventory.length')).toBe(3);
  });
});

describe('evaluatePredicate — each op', () => {
  const before = { score: 1, hp: 10, name: 'mario', dead: false, pos: { x: 0 } };
  const after = { score: 5, hp: 7, name: 'mario', dead: true, pos: { x: 12 } };

  it('eq: passes when path equals value', () => {
    const expr: PredicateExpr = { op: 'eq', path: 'name', value: 'mario' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('eq: fails when path does not equal value', () => {
    const expr: PredicateExpr = { op: 'eq', path: 'name', value: 'luigi' };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('increase: passes when after > before', () => {
    const expr: PredicateExpr = { op: 'increase', path: 'score' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('increase: fails when after <= before', () => {
    const expr: PredicateExpr = { op: 'increase', path: 'hp' };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('increase: fails when path is non-numeric', () => {
    const expr: PredicateExpr = { op: 'increase', path: 'name' };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('decrease: passes when after < before', () => {
    const expr: PredicateExpr = { op: 'decrease', path: 'hp' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('decrease: fails when after >= before', () => {
    const expr: PredicateExpr = { op: 'decrease', path: 'score' };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('change: detects nested change', () => {
    const expr: PredicateExpr = { op: 'change', path: 'pos.x' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('change: false when nothing changed', () => {
    const expr: PredicateExpr = { op: 'change', path: 'name' };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('truthy: passes when after path is truthy', () => {
    const expr: PredicateExpr = { op: 'truthy', path: 'dead' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('falsy: passes when after path is falsy', () => {
    // path doesn't exist -> falsy
    const expr: PredicateExpr = { op: 'falsy', path: 'gameOver' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('matches: regex against string value', () => {
    const expr: PredicateExpr = { op: 'matches', path: 'name', pattern: '^mar' };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('matches: fails when value not a string', () => {
    const expr: PredicateExpr = { op: 'matches', path: 'score', pattern: '^5$' };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('and: all clauses must pass', () => {
    const expr: PredicateExpr = {
      op: 'and',
      clauses: [
        { op: 'increase', path: 'score' },
        { op: 'truthy', path: 'dead' },
      ],
    };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('and: fails if any clause fails', () => {
    const expr: PredicateExpr = {
      op: 'and',
      clauses: [
        { op: 'increase', path: 'score' },
        { op: 'increase', path: 'hp' },
      ],
    };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });

  it('or: passes if any clause passes', () => {
    const expr: PredicateExpr = {
      op: 'or',
      clauses: [
        { op: 'increase', path: 'hp' },
        { op: 'increase', path: 'score' },
      ],
    };
    expect(evaluatePredicate(expr, before, after)).toBe(true);
  });

  it('or: fails if all clauses fail', () => {
    const expr: PredicateExpr = {
      op: 'or',
      clauses: [
        { op: 'increase', path: 'hp' },
        { op: 'eq', path: 'name', value: 'luigi' },
      ],
    };
    expect(evaluatePredicate(expr, before, after)).toBe(false);
  });
});

describe('evaluatePredicateWithReason — readable failure messages', () => {
  it('returns descriptive reason on increase failure', () => {
    const r = evaluatePredicateWithReason(
      { op: 'increase', path: 'score' },
      { score: 5 },
      { score: 5 },
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('score');
    expect(r.reason).toContain('no increase');
  });

  it('returns descriptive reason on eq failure', () => {
    const r = evaluatePredicateWithReason(
      { op: 'eq', path: 'state', value: 'won' },
      undefined,
      { state: 'lost' },
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('eq failed');
    expect(r.reason).toContain('"lost"');
  });

  it('returns combined reason for and failure', () => {
    const r = evaluatePredicateWithReason(
      {
        op: 'and',
        clauses: [
          { op: 'eq', path: 'a', value: 1 },
          { op: 'eq', path: 'b', value: 2 },
        ],
      },
      undefined,
      { a: 1, b: 99 },
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('and failed');
  });
});

describe('VERB_REGISTRY', () => {
  it('covers all 13 verbs in the 6-class taxonomy', () => {
    const expected: VerbId[] = [
      'moveTo',
      'traverse',
      'collect',
      'unlock',
      'defeat',
      'defend',
      'evade',
      'build',
      'upgrade',
      'solve',
      'navigate',
      'complete',
      'fail',
    ];
    for (const id of expected) {
      expect(VERB_REGISTRY[id]).toBeDefined();
      expect(VERB_REGISTRY[id].class).toBeTypeOf('string');
      expect(VERB_REGISTRY[id].description).toBeTypeOf('string');
      expect(Array.isArray(VERB_REGISTRY[id].commonSelectors)).toBe(true);
      expect(VERB_REGISTRY[id].defaultSuccess).toBeDefined();
    }
  });

  it('getVerbMetadata returns the right entry', () => {
    expect(getVerbMetadata('defeat').class).toBe('conflict');
    expect(getVerbMetadata('collect').class).toBe('acquisition');
    expect(getVerbMetadata('complete').class).toBe('progression');
  });

  it('every common selector matches at least one realistic snapshot path', () => {
    // 抽样 — 不是穷尽，但覆盖每个 verb 至少一个 commonSelector
    const cases: Array<[VerbId, Record<string, unknown>, string]> = [
      ['moveTo', { player: { x: 10 } }, 'player.x'],
      ['traverse', { player: { airborne: true } }, 'player.airborne'],
      ['collect', { coinsCollected: 5 }, 'coinsCollected'],
      ['unlock', { gatesUnlocked: 1 }, 'gatesUnlocked'],
      ['defeat', { enemiesDefeated: 2 }, 'enemiesDefeated'],
      ['defend', { baseHealth: 100 }, 'baseHealth'],
      ['evade', { evadeCount: 3 }, 'evadeCount'],
      ['build', { towersBuilt: 1 }, 'towersBuilt'],
      ['upgrade', { playerLevel: 5 }, 'playerLevel'],
      ['solve', { puzzleSolved: true }, 'puzzleSolved'],
      ['navigate', { exitReached: true }, 'exitReached'],
      ['complete', { levelComplete: true }, 'levelComplete'],
      ['fail', { gameOver: true }, 'gameOver'],
    ];
    for (const [verb, snapshot, path] of cases) {
      const meta = getVerbMetadata(verb);
      const value = extractByPath(snapshot, path);
      expect(value).not.toBeUndefined();
      const matched = meta.commonSelectors.some((sel: string | RegExp) => {
        if (typeof sel === 'string') return sel === path;
        return sel.test(path);
      });
      expect(matched, `verb=${verb} path=${path} not matched by commonSelectors`).toBe(
        true,
      );
    }
  });
});
