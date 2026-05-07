/** RunnerChecker — endless runner subtype（task D）。与 PlatformerChecker 同形。 */
import type {
  GameSubtypeChecker,
  MechanicsResult,
  RuntimeEvidenceResult,
  Snapshot,
  SmokeResult,
  SubtypeContext,
  VerbDeclaration,
  VerbEvidence,
} from '../types';
import { evaluatePredicateWithReason, extractByPath } from '../verbs';
import { gameSubtypeRegistry } from '../registry';
import {
  RUNNER_REPAIR_CODES,
  RUNNER_REPAIR_CODE_SET,
  classifyRunnerFailure,
  lookupRunnerRepair,
  type RunnerRepairCode,
} from './repairCodes';

const RUNNER_SUBTYPE_PATTERNS: readonly RegExp[] = [
  /__(?:GAME|INTERACTIVE)_META__[\s\S]{0,2500}\b(?:subtype|genre|type)\s*:\s*['"`]runner['"`]/i,
  /(?:game|interactive)-meta[\s\S]{0,2500}"(?:subtype|genre|type)"\s*:\s*"runner"/i,
];
const AUTO_RUN_PATTERN =
  /\b(?:autoRun|forwardMotion|forwardAxis|runSpeed|autoForward)\b\s*:\s*(?:true|['"`]?(?:x|y|right|down|forward)['"`]?|\d)/i;
const OBSTACLE_ARRAY_PATTERN = /["']?obstacles["']?\s*:\s*\[/i;
const PICKUP_ARRAY_PATTERN = /["']?(?:pickups|coins|collectibles)["']?\s*:\s*\[/i;

export function isRunnerArtifact(content: string): boolean {
  return RUNNER_SUBTYPE_PATTERNS.some((pattern) => pattern.test(content));
}

const DECLARED_VERBS: readonly VerbDeclaration[] = [
  { verb: 'moveTo', selector: 'distanceTraveled', successPredicate: { op: 'increase', path: 'distanceTraveled' }, required: true },
  { verb: 'evade', selector: 'obstaclesAvoided', successPredicate: { op: 'increase', path: 'obstaclesAvoided' }, required: true },
  { verb: 'collect', selector: 'pickupsCollected', successPredicate: { op: 'increase', path: 'pickupsCollected' }, required: false },
  { verb: 'complete', selector: 'distanceTraveled', successPredicate: { op: 'increase', path: 'distanceTraveled' }, required: true },
  { verb: 'fail', selector: 'gameOver', successPredicate: { op: 'truthy', path: 'gameOver' }, required: false },
];

export class RunnerChecker implements GameSubtypeChecker {
  readonly subtype = 'runner';
  readonly declaredVerbs = DECLARED_VERBS;

  validateMechanics(snippet: string, _ctx: SubtypeContext): MechanicsResult {
    if (!isRunnerArtifact(snippet)) {
      return { passed: true, failures: [], checks: [] };
    }
    const failures: string[] = [];
    const checks: string[] = ['runner subtype contract applies'];

    if (!AUTO_RUN_PATTERN.test(snippet)) {
      failures.push(
        'runner 缺少 autoRun / forwardMotion 声明；__GAME_META__ 必须设置 autoRun: true 加 forwardAxis 与 runSpeed，step() 即使空 input 也要让 distanceTraveled 增长。',
      );
    } else {
      checks.push('runner autoRun / forwardMotion declared');
    }

    if (!OBSTACLE_ARRAY_PATTERN.test(snippet)) {
      failures.push(
        'runner 缺少 obstacles 数组；__GAME_META__.obstacles 必须是数组，每条至少含 { id, type, position, action }。',
      );
    } else {
      checks.push('runner obstacles array declared');
    }

    if (PICKUP_ARRAY_PATTERN.test(snippet)) {
      checks.push('runner pickups array declared');
    }

    return { passed: failures.length === 0, failures, checks };
  }

  validateRuntimeEvidence(
    beforeSnap: Snapshot,
    afterSnap: Snapshot,
    smoke: SmokeResult,
    _ctx: SubtypeContext,
  ): RuntimeEvidenceResult {
    const failures: string[] = [];
    const checks: string[] = [];
    const verbEvidence: VerbEvidence[] = [];

    for (const decl of this.declaredVerbs) {
      const r = evaluatePredicateWithReason(decl.successPredicate, beforeSnap, afterSnap);
      verbEvidence.push({ verb: decl.verb, selector: decl.selector, passed: r.passed, reason: r.reason });
      if (r.passed) {
        checks.push(`runner verb ${decl.verb}(${decl.selector}) evidence: ${r.reason}`);
      } else if (decl.required) {
        failures.push(`runner ${decl.verb} 缺少证据 (selector=${decl.selector}): ${r.reason}`);
      }
    }

    const afterDistance = Number(extractByPath(afterSnap, 'distanceTraveled'));
    if (!Number.isFinite(afterDistance) || afterDistance <= 0) {
      failures.push(
        'runner_no_distance_progression: distanceTraveled 在 after snapshot 中仍为 0 或缺失；step() 必须无条件推进距离。',
      );
    } else {
      checks.push(`runner distanceTraveled reached ${afterDistance}`);
    }

    if (smoke.attempted && !smoke.passed && failures.length === 0) {
      checks.push('runner runtime evidence derived from snapshot deltas (smoke not passed)');
    }

    return { passed: failures.length === 0, failures, checks, verbEvidence };
  }

  repairGuidance(failureCode: string): string | undefined {
    return lookupRunnerRepair(failureCode)?.repairInstruction;
  }
}

export const runnerChecker = new RunnerChecker();
gameSubtypeRegistry.register(runnerChecker);

export { RUNNER_REPAIR_CODES, RUNNER_REPAIR_CODE_SET, classifyRunnerFailure, lookupRunnerRepair };
export type { RunnerRepairCode };
