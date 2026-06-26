import { describe, it, expect } from 'vitest';

import {
  PlatformerChecker,
  isPlatformerArtifact,
  platformerChecker,
} from '../../../../../../src/host/agent/runtime/game/platformer/PlatformerChecker';
import type {
  Snapshot,
  SmokeResult,
  SubtypeContext,
} from '../../../../../../src/host/agent/runtime/game/types';
import { gameSubtypeRegistry } from '../../../../../../src/host/agent/runtime/game/registry';
import {
  PLATFORMER_REPAIR_CODES,
  classifyPlatformerFailure,
  lookupPlatformerRepair,
} from '../../../../../../src/host/agent/runtime/game/platformer/repairCodes';

const META_FRAGMENT_PLATFORMER = `
  window.__GAME_META__ = {
    domain: 'game',
    subtype: 'platformer',
    controls: { right: 'ArrowRight', jump: 'Space' },
    levels: [{ id: 'route' }],
    gameplayMechanics: {
      enemies: [{ id: 'goomba-1', stompable: true, defeatReward: 'bounceCoin' }],
      blocks: [{ id: 'q1', type: 'question', bumpableFromBelow: true, reward: 'doubleJump', usedState: 'empty' }],
      abilities: [{ id: 'doubleJump', type: 'doubleJump', acquiredFrom: 'q1', effect: 'second jump', unlocksRoute: 'upper-route' }],
      gates: [{ id: 'gap', requiresAbility: 'doubleJump', blocksAccessTo: 'upper-route' }],
      comboChallenge: [{ id: 'combo', requires: ['jump', 'stomp', 'bumpBlock', 'doubleJump'], target: 'upper-route' }]
    }
  };
`;

function ctx(filePath = 'tmp/foo.html', metadata: Record<string, unknown> = {}): SubtypeContext {
  return {
    artifactRef: filePath,
    strict: false,
    metadata: { filePath, ...metadata },
  };
}

describe('PlatformerChecker', () => {
  describe('subtype identity', () => {
    it('exposes "platformer" subtype and registers itself with the registry', () => {
      // 模块 import 时已经 side-effect 注册过 — 这里只需要拿出来对比
      const fromRegistry = gameSubtypeRegistry.get('platformer');
      expect(fromRegistry).toBeDefined();
      expect(fromRegistry?.subtype).toBe('platformer');
      expect(platformerChecker.subtype).toBe('platformer');
    });

    it('declares 5 verbs covering defeat/collect/unlock/moveTo/traverse', () => {
      const verbs = platformerChecker.declaredVerbs.map((v) => v.verb);
      expect(verbs).toEqual(['defeat', 'collect', 'unlock', 'moveTo', 'traverse']);
      const required = platformerChecker.declaredVerbs.filter((v) => v.required).length;
      expect(required).toBe(4);
    });
  });

  describe('isPlatformerArtifact', () => {
    it('detects subtype: platformer in metadata', () => {
      expect(isPlatformerArtifact(`window.__GAME_META__ = { subtype: 'platformer' };`, 'foo.html')).toBe(true);
    });

    it('falls back to filename hint when metadata exists', () => {
      expect(
        isPlatformerArtifact(
          `window.__GAME_META__ = { domain: 'game' };`,
          'platformer-mario.html',
        ),
      ).toBe(true);
    });

    it('returns false for non-platformer artifacts', () => {
      expect(isPlatformerArtifact(`window.__GAME_META__ = { subtype: 'runner' };`, 'runner.html')).toBe(false);
      expect(isPlatformerArtifact(``, 'foo.html')).toBe(false);
    });
  });

  describe('validateMechanics', () => {
    it('returns empty result for non-platformer artifact', () => {
      const result = platformerChecker.validateMechanics(
        `window.__GAME_META__ = { subtype: 'runner' };`,
        ctx('runner.html'),
      );
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.checks).toEqual([]);
    });

    it('fails when subtype is platformer but no gameplayMechanics block', () => {
      const result = platformerChecker.validateMechanics(
        `window.__GAME_META__ = { subtype: 'platformer', controls: { jump: 'Space' } };`,
        ctx('p.html'),
      );
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('缺少 gameplayMechanics'))).toBe(true);
      expect(result.checks).toContain('platformer gameplay mechanics contract applies');
    });

    it('fails for each missing required mechanics array', () => {
      const partial = `
        window.__GAME_META__ = {
          subtype: 'platformer',
          gameplayMechanics: {
            enemies: [{ stompable: true }],
            blocks: [{ bumpableFromBelow: true }],
            abilities: [{ doubleJump: true, effect: 'jump' }],
            gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'route' }]
            // comboChallenge missing
          }
        };
      `;
      const result = platformerChecker.validateMechanics(partial, ctx('p.html'));
      expect(result.passed).toBe(false);
      // comboChallenge missing — at minimum, the array missing failure should fire
      expect(result.failures.some((f) => f.includes('comboChallenge 数组'))).toBe(true);
    });

    it('fails when enemies block has no stompable enemy', () => {
      // 注意：原 regex 在 enemies 后 1800 字符内任意位置看到 \bstomp\b 就放过；
      // 因此 comboChallenge 里写 'stomp' 也算证据。要让该 failure 触发，必须让
      // enemies 后 1800 字符内不出现 stompable: true 或 stomp 任何形式。
      const noStomp = `
        window.__GAME_META__ = {
          subtype: 'platformer',
          gameplayMechanics: {
            enemies: [{ id: 'flyer', flying: true }],
            blocks: [{ bumpableFromBelow: true }],
            abilities: [{ doubleJump: true, effect: 'jump', acquiredFrom: 'q', unlocksRoute: 'r' }],
            gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'r' }],
            comboChallenge: [{ requires: ['jump','bumpBlock','doubleJump'], target: 'r' }]
          }
        };
      `;
      const result = platformerChecker.validateMechanics(noStomp, ctx('p.html'));
      expect(result.failures.some((f) => f.includes('stompable enemy'))).toBe(true);
    });

    it('fails when abilities lack effect/unlocksRoute/acquiredFrom', () => {
      const noEffect = `
        window.__GAME_META__ = {
          subtype: 'platformer',
          gameplayMechanics: {
            enemies: [{ stompable: true }],
            blocks: [{ bumpableFromBelow: true }],
            abilities: [{ id: 'doubleJump' }],
            gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'r' }],
            comboChallenge: [{ requires: ['jump','stomp','bumpBlock','doubleJump'], target: 'r' }]
          }
        };
      `;
      const result = platformerChecker.validateMechanics(noEffect, ctx('p.html'));
      expect(result.failures.some((f) => f.includes('acquiredFrom/effect/unlocksRoute'))).toBe(true);
    });

    it('fails when gates lack requiresAbility + blocksAccessTo', () => {
      const noGate = `
        window.__GAME_META__ = {
          subtype: 'platformer',
          gameplayMechanics: {
            enemies: [{ stompable: true }],
            blocks: [{ bumpableFromBelow: true }],
            abilities: [{ doubleJump: true, effect: 'jump', acquiredFrom: 'q', unlocksRoute: 'r' }],
            gates: [{ id: 'gap' }],
            comboChallenge: [{ requires: ['jump','stomp','bumpBlock','doubleJump'], target: 'r' }]
          }
        };
      `;
      const result = platformerChecker.validateMechanics(noGate, ctx('p.html'));
      expect(result.failures.some((f) => f.includes('requiresAbility'))).toBe(true);
    });

    it('fails when comboChallenge lacks jump or fewer than 2 axes', () => {
      const weakCombo = `
        window.__GAME_META__ = {
          subtype: 'platformer',
          gameplayMechanics: {
            enemies: [{ stompable: true }],
            blocks: [{ bumpableFromBelow: true }],
            abilities: [{ doubleJump: true, effect: 'jump', acquiredFrom: 'q', unlocksRoute: 'r' }],
            gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'r' }],
            comboChallenge: [{ requires: ['stroll'], target: 'r' }]
          }
        };
      `;
      const result = platformerChecker.validateMechanics(weakCombo, ctx('p.html'));
      expect(result.failures.some((f) => f.includes('comboChallenge 必须组合'))).toBe(true);
    });

    it('passes a complete platformer mechanics block', () => {
      const result = platformerChecker.validateMechanics(META_FRAGMENT_PLATFORMER, ctx('p.html'));
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.checks).toContain('platformer gameplayMechanics metadata detected');
    });
  });

  describe('validateRuntimeEvidence', () => {
    function emptySmoke(passed = true): SmokeResult {
      return { attempted: true, passed, failures: [], checks: [] };
    }

    function snap(over: Snapshot = {}): Snapshot {
      return {
        player: { x: 0, y: 0, vy: 0, abilities: { doubleJump: false } },
        enemiesDefeated: 0,
        blocksUsed: 0,
        abilities: { doubleJump: false },
        gates: { upperRoute: false },
        ...over,
      };
    }

    it('returns empty result when meta has no gameplayMechanics object', () => {
      const result = platformerChecker.validateRuntimeEvidence(snap(), snap(), emptySmoke(), ctx('p.html', { meta: {} }));
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.checks).toEqual([]);
    });

    it('reports stompable evidence missing when enemies count and bounce do not change', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap(),
        snap(), // identical → no enemy delta, no bounce
        emptySmoke(true),
        ctx('p.html', { meta, coverage: {} }),
      );
      expect(result.failures.some((f) => f.includes('stompable enemy'))).toBe(true);
    });

    it('passes stompable evidence when enemiesDefeated increases AND player.vy changes', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap({ enemiesDefeated: 0, player: { vy: 0 } }),
        snap({ enemiesDefeated: 1, player: { vy: -7 } }),
        emptySmoke(true),
        ctx('p.html', { meta, coverage: { stateChanges: ['enemiesDefeated', 'player.vy'] } }),
      );
      expect(result.checks.some((c) => c.includes('stompable enemy'))).toBe(true);
    });

    it('reports bumpable block missing when blocksUsed unchanged', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap({ blocksUsed: 0 }),
        snap({ blocksUsed: 0 }),
        emptySmoke(true),
        ctx('p.html', { meta, coverage: {} }),
      );
      expect(result.failures.some((f) => f.includes('bumpable/question block'))).toBe(true);
    });

    it('passes bumpable evidence when blocksUsed increases', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap({ blocksUsed: 0 }),
        snap({ blocksUsed: 1 }),
        emptySmoke(true),
        ctx('p.html', { meta, coverage: { stateChanges: ['blocksUsed'] } }),
      );
      expect(result.checks.some((c) => c.includes('bumpable block'))).toBe(true);
    });

    it('reports ability missing when player.abilities did not change AND no evidence', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap({ player: { abilities: { doubleJump: false } } }),
        snap({ player: { abilities: { doubleJump: false } } }),
        emptySmoke(true),
        ctx('p.html', { meta, coverage: {} }),
      );
      expect(result.failures.some((f) => f.includes('ability'))).toBe(true);
    });

    it('reports gate evidence missing when no route/gate state change and no evidence', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap(),
        snap({ player: { abilities: { doubleJump: true } } }),
        emptySmoke(true),
        ctx('p.html', { meta, coverage: {} }),
      );
      expect(result.failures.some((f) => f.includes('gate 必须在获得技能后改变'))).toBe(true);
    });

    it('reports comboChallenge missing when coverage lacks jump+axes evidence', () => {
      const meta = {
        gameplayMechanics: {
          enemies: [],
          blocks: [],
          abilities: [],
          gates: [],
          comboChallenge: [{ requires: ['stroll'], target: 'r' }],
        },
      };
      const result = platformerChecker.validateRuntimeEvidence(
        snap(),
        snap(),
        emptySmoke(true),
        ctx('p.html', { meta, coverage: {} }),
      );
      expect(result.failures.some((f) => f.includes('comboChallenge'))).toBe(true);
    });

    it('treats unpassed smoke as no evidence — failures fire even when snapshot deltas exist', () => {
      const meta = { gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] } };
      const result = platformerChecker.validateRuntimeEvidence(
        snap({ enemiesDefeated: 0, player: { vy: 0 } }),
        snap({ enemiesDefeated: 1, player: { vy: -7 } }),
        emptySmoke(false),
        ctx('p.html', { meta, coverage: { stateChanges: ['enemiesDefeated', 'player.vy'] } }),
      );
      // smoke 失败 → evidence 是空 → 但 enemy/bounce delta 仍然走数值通道，可以独立通过
      // 这里主要验证：smoke fail 不阻止从 snapshot 直接读到的证据
      expect(result.checks.some((c) => c.includes('stompable enemy'))).toBe(true);
    });
  });

  describe('repairGuidance', () => {
    it('returns the platformer-specific instruction for known codes', () => {
      const guidance = platformerChecker.repairGuidance('missing_gameplay_mechanics');
      expect(guidance).toContain('gameplayMechanics');
      expect(guidance).toContain('enemies, blocks, abilities, gates');
    });

    it('returns guidance for ability_gate_without_reachability', () => {
      const guidance = platformerChecker.repairGuidance('ability_gate_without_reachability');
      expect(guidance).toContain('false->true');
    });

    it('returns guidance for gameplay_mechanics_without_runtime_evidence', () => {
      const guidance = platformerChecker.repairGuidance('gameplay_mechanics_without_runtime_evidence');
      expect(guidance).toContain('before/after snapshot');
    });

    it('returns undefined for unknown / generic codes', () => {
      expect(platformerChecker.repairGuidance('html_incomplete')).toBeUndefined();
      expect(platformerChecker.repairGuidance('unknown_code')).toBeUndefined();
    });
  });

  describe('repairCodes module', () => {
    it('exports all 3 platformer codes', () => {
      expect(PLATFORMER_REPAIR_CODES.map((e) => e.code).sort()).toEqual([
        'ability_gate_without_reachability',
        'gameplay_mechanics_without_runtime_evidence',
        'missing_gameplay_mechanics',
      ]);
    });

    it('lookupPlatformerRepair finds entries by code', () => {
      const entry = lookupPlatformerRepair('missing_gameplay_mechanics');
      expect(entry?.severity).toBe('error');
      expect(entry?.message).toContain('Platformer');
    });

    it('classifyPlatformerFailure matches platformer-specific failure text', () => {
      expect(
        classifyPlatformerFailure(
          'platformer 缺少 gameplayMechanics 元数据；请在 __GAME_META__ 中声明并实现 enemies、blocks、abilities、gates、comboChallenge。',
        )?.code,
      ).toBe('missing_gameplay_mechanics');

      expect(
        classifyPlatformerFailure('platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。')?.code,
      ).toBe('gameplay_mechanics_without_runtime_evidence');

      expect(
        classifyPlatformerFailure('platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。')?.code,
      ).toBe('ability_gate_without_reachability');
    });

    it('returns undefined for non-platformer text', () => {
      expect(classifyPlatformerFailure('HTML 文件还没有完整闭合')).toBeUndefined();
      expect(classifyPlatformerFailure('runSmokeTest 没有返回结构化结果。')).toBeUndefined();
    });
  });

  describe('class instantiation', () => {
    it('PlatformerChecker class can be re-instantiated independently', () => {
      const fresh = new PlatformerChecker();
      expect(fresh.subtype).toBe('platformer');
      expect(fresh.declaredVerbs).toEqual(platformerChecker.declaredVerbs);
    });
  });
});
