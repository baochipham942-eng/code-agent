import { describe, it, expect } from 'vitest';

import {
  RunnerChecker,
  isRunnerArtifact,
  runnerChecker,
} from '../../../../../../src/host/agent/runtime/game/runner/RunnerChecker';
import type {
  Snapshot,
  SmokeResult,
  SubtypeContext,
} from '../../../../../../src/host/agent/runtime/game/types';
import { gameSubtypeRegistry } from '../../../../../../src/host/agent/runtime/game/registry';
import {
  RUNNER_REPAIR_CODES,
  classifyRunnerFailure,
  lookupRunnerRepair,
} from '../../../../../../src/host/agent/runtime/game/runner/repairCodes';

const META_FRAGMENT_RUNNER = `
  window.__GAME_META__ = {
    domain: 'game',
    subtype: 'runner',
    autoRun: true,
    forwardAxis: 'x',
    runSpeed: 4,
    controls: { jump: 'Space', slide: 'ArrowDown' },
    obstacles: [
      { id: 'spike-1', type: 'spike', position: 200, action: 'jump' },
      { id: 'wall-1', type: 'wall', position: 400, action: 'slide' }
    ],
    pickups: [{ id: 'coin-1', type: 'coin', position: 150 }]
  };
`;

const META_FRAGMENT_RUNNER_NO_AUTORUN = `
  window.__GAME_META__ = {
    domain: 'game',
    subtype: 'runner',
    controls: { jump: 'Space' },
    obstacles: [{ id: 's', type: 'spike', position: 100, action: 'jump' }]
  };
`;

const META_FRAGMENT_RUNNER_NO_OBSTACLES = `
  window.__GAME_META__ = {
    domain: 'game',
    subtype: 'runner',
    autoRun: true,
    runSpeed: 4,
    controls: { jump: 'Space' }
  };
`;

const META_FRAGMENT_PLATFORMER = `
  window.__GAME_META__ = {
    domain: 'game',
    subtype: 'platformer',
    controls: { right: 'ArrowRight', jump: 'Space' }
  };
`;

function ctx(filePath = 'tmp/runner.html', metadata: Record<string, unknown> = {}): SubtypeContext {
  return {
    artifactRef: filePath,
    strict: false,
    metadata: { filePath, ...metadata },
  };
}

function emptySmoke(passed = false): SmokeResult {
  // 注：SmokeResult 早已把诊断字段从 coverage 重命名为 diagnostics（且从未收窄到
  // 具体形状），这里没有测试读 coverage，直接去掉这个过时字段。
  return { attempted: true, passed, checks: [], failures: [] };
}

describe('RunnerChecker', () => {
  describe('subtype identity', () => {
    it('exposes "runner" subtype and registers itself', () => {
      const fromRegistry = gameSubtypeRegistry.get('runner');
      expect(fromRegistry).toBeDefined();
      expect(fromRegistry?.subtype).toBe('runner');
      expect(fromRegistry).toBe(runnerChecker);
    });

    it('declares 5 verbs across 3 verb classes', () => {
      const verbs = runnerChecker.declaredVerbs.map((v) => v.verb);
      expect(verbs).toContain('moveTo');
      expect(verbs).toContain('evade');
      expect(verbs).toContain('collect');
      expect(verbs).toContain('complete');
      expect(verbs).toContain('fail');
    });
  });

  describe('isRunnerArtifact', () => {
    it('matches subtype: runner in __GAME_META__', () => {
      expect(isRunnerArtifact(META_FRAGMENT_RUNNER)).toBe(true);
    });

    it('rejects platformer artifact', () => {
      expect(isRunnerArtifact(META_FRAGMENT_PLATFORMER)).toBe(false);
    });

    it('rejects empty content', () => {
      expect(isRunnerArtifact('')).toBe(false);
    });
  });

  describe('validateMechanics', () => {
    it('passes a complete runner metadata fragment', () => {
      const result = new RunnerChecker().validateMechanics(META_FRAGMENT_RUNNER, ctx());
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.checks).toContain('runner subtype contract applies');
      expect(result.checks).toContain('runner autoRun / forwardMotion declared');
      expect(result.checks).toContain('runner obstacles array declared');
      expect(result.checks).toContain('runner pickups array declared');
    });

    it('fails when autoRun / forwardMotion is not declared', () => {
      const result = new RunnerChecker().validateMechanics(META_FRAGMENT_RUNNER_NO_AUTORUN, ctx());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => /autoRun|forwardMotion/.test(f))).toBe(true);
    });

    it('fails when obstacles array is missing', () => {
      const result = new RunnerChecker().validateMechanics(META_FRAGMENT_RUNNER_NO_OBSTACLES, ctx());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => /obstacles/.test(f))).toBe(true);
    });

    it('does not assert ownership when content is platformer', () => {
      // 不是 runner 的 artifact，validateMechanics 应当短路返回 passed=true（不归我管）
      const result = new RunnerChecker().validateMechanics(META_FRAGMENT_PLATFORMER, ctx());
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.checks).toEqual([]);
    });
  });

  describe('validateRuntimeEvidence', () => {
    const before: Snapshot = {
      distanceTraveled: 0,
      obstaclesAvoided: 0,
      pickupsCollected: 0,
      gameOver: false,
    };

    it('passes when distance + obstaclesAvoided both increase', () => {
      const after: Snapshot = {
        distanceTraveled: 96,
        obstaclesAvoided: 2,
        pickupsCollected: 1,
        gameOver: false,
      };
      const result = new RunnerChecker().validateRuntimeEvidence(before, after, emptySmoke(true), ctx());
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      // 命中的 verb 至少包含 moveTo / evade / complete / collect 这 4 个有 increase 证据的
      const passedVerbs = result.verbEvidence?.filter((e) => e.passed).map((e) => e.verb) ?? [];
      expect(passedVerbs).toContain('moveTo');
      expect(passedVerbs).toContain('evade');
      expect(passedVerbs).toContain('collect');
      expect(passedVerbs).toContain('complete');
    });

    it('fails when distance does not increase (auto-run broken)', () => {
      const after: Snapshot = {
        distanceTraveled: 0,
        obstaclesAvoided: 0,
        pickupsCollected: 0,
        gameOver: false,
      };
      const result = new RunnerChecker().validateRuntimeEvidence(before, after, emptySmoke(), ctx());
      expect(result.passed).toBe(false);
      // distance 失败 + verb evidence 失败两路都该报
      expect(result.failures.some((f) => /distanceTraveled/.test(f))).toBe(true);
      expect(result.failures.some((f) => /moveTo|complete/.test(f))).toBe(true);
    });

    it('fails when obstaclesAvoided does not increase (evade is required)', () => {
      const after: Snapshot = {
        distanceTraveled: 100,
        obstaclesAvoided: 0,
        pickupsCollected: 0,
        gameOver: false,
      };
      const result = new RunnerChecker().validateRuntimeEvidence(before, after, emptySmoke(true), ctx());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => /evade/.test(f))).toBe(true);
    });

    it('passes when collect verb evidence missing (pickups optional)', () => {
      const after: Snapshot = {
        distanceTraveled: 50,
        obstaclesAvoided: 1,
        pickupsCollected: 0, // 没收 pickup — collect 没证据但 required:false
        gameOver: false,
      };
      const result = new RunnerChecker().validateRuntimeEvidence(before, after, emptySmoke(true), ctx());
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('does not require gameOver to be true (fail verb is optional)', () => {
      const after: Snapshot = {
        distanceTraveled: 50,
        obstaclesAvoided: 1,
        pickupsCollected: 0,
        gameOver: false, // 没死，但 fail required:false
      };
      const result = new RunnerChecker().validateRuntimeEvidence(before, after, emptySmoke(true), ctx());
      expect(result.passed).toBe(true);
    });
  });

  describe('repairGuidance', () => {
    it('returns instruction for known runner code', () => {
      const guidance = runnerChecker.repairGuidance('missing_runner_loop_metadata');
      expect(guidance).toBeDefined();
      expect(guidance).toMatch(/autoRun/);
    });

    it('returns instruction for runner_no_distance_progression', () => {
      const guidance = runnerChecker.repairGuidance('runner_no_distance_progression');
      expect(guidance).toBeDefined();
      expect(guidance).toMatch(/distanceTraveled/);
    });

    it('returns undefined for unknown code', () => {
      expect(runnerChecker.repairGuidance('unknown_code')).toBeUndefined();
    });

    it('does not respond to platformer codes', () => {
      expect(runnerChecker.repairGuidance('missing_gameplay_mechanics')).toBeUndefined();
    });
  });

  describe('repairCodes module', () => {
    it('exports 3 codes', () => {
      expect(RUNNER_REPAIR_CODES).toHaveLength(3);
      expect(RUNNER_REPAIR_CODES.map((e) => e.code).sort()).toEqual([
        'missing_obstacle_metadata',
        'missing_runner_loop_metadata',
        'runner_no_distance_progression',
      ]);
    });

    it('classifyRunnerFailure matches runner-specific failure text', () => {
      const matched = classifyRunnerFailure('runner 缺少 autoRun 声明');
      expect(matched?.code).toBe('missing_runner_loop_metadata');
    });

    it('classifyRunnerFailure does not match generic text', () => {
      expect(classifyRunnerFailure('something completely unrelated')).toBeUndefined();
    });

    it('lookupRunnerRepair returns full entry by code', () => {
      const entry = lookupRunnerRepair('missing_obstacle_metadata');
      expect(entry?.severity).toBe('error');
      expect(entry?.hints.length).toBeGreaterThan(0);
    });

    it('all entries have non-empty repair instruction + hints', () => {
      for (const entry of RUNNER_REPAIR_CODES) {
        expect(entry.repairInstruction.length).toBeGreaterThan(40);
        expect(entry.hints.length).toBeGreaterThan(0);
      }
    });
  });
});
