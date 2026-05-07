/**
 * Runner-specific 失败码与匹配规则。与 platformer/repairCodes.ts 同形。
 */
import type { ArtifactRepairIssueSeverity } from '../../artifactRepairSpec';

export type RunnerRepairCode =
  | 'missing_runner_loop_metadata'
  | 'missing_obstacle_metadata'
  | 'runner_no_distance_progression';

export interface RunnerRepairEntry {
  code: RunnerRepairCode;
  pattern: RegExp;
  severity: ArtifactRepairIssueSeverity;
  message: string;
  repairInstruction: string;
  hints: readonly string[];
}

export const RUNNER_REPAIR_CODES: readonly RunnerRepairEntry[] = [
  {
    code: 'missing_runner_loop_metadata',
    pattern: /runner[\s\S]{0,80}缺少 (?:autoRun|forwardMotion|loop)|autoRun[\s\S]{0,40}必须|runner_loop_metadata/i,
    severity: 'error',
    message: 'Runner artifact is missing auto-run / forward-motion declaration in __GAME_META__.',
    repairInstruction:
      'Declare the auto-run loop in __GAME_META__: set autoRun: true plus a forwardAxis ("x" or "y") and runSpeed. The step(input, frames) function must advance distanceTraveled even with empty input — forward motion is implicit from the time-step itself.',
    hints: [
      'Runner metadata template: __GAME_META__.autoRun = true; __GAME_META__.forwardAxis = "x"; __GAME_META__.runSpeed = 4. snapshot() must expose distanceTraveled (monotonic number).',
      'Implement step() so it always increments distanceTraveled regardless of input — input controls only jump/slide/lane-swap, not forward motion.',
    ],
  },
  {
    code: 'missing_obstacle_metadata',
    pattern: /runner[\s\S]{0,80}缺少 obstacles|obstacles?\[\][\s\S]{0,40}必须|obstacle_metadata/i,
    severity: 'error',
    message: 'Runner artifact is missing obstacles array in __GAME_META__.',
    repairInstruction:
      'Add an obstacles array to __GAME_META__ with at least one entry: { id, type, position, action }. The action field tells the player how to dodge (jump / slide / swap-lane) and runSmokeTest must drive that input to prove obstaclesAvoided increments.',
    hints: [
      'Obstacles template: __GAME_META__.obstacles = [{ id: "spike-1", type: "spike", position: 200, action: "jump" }, { id: "wall-1", type: "wall", position: 400, action: "slide" }].',
      'Each obstacle type needs at least one corresponding control declared (Space → jump, ArrowDown → slide). Hitting an unhandled obstacle should set gameOver=true.',
    ],
  },
  {
    code: 'runner_no_distance_progression',
    pattern: /distanceTraveled[\s\S]{0,40}(?:no increase|未增加|不变)|runner_no_distance_progression|distance not increasing/i,
    severity: 'error',
    message: 'Runner runtime evidence shows distanceTraveled did not increase after step().',
    repairInstruction:
      'Make step() unconditionally advance distanceTraveled by runSpeed * frames (or by per-frame integration) regardless of input. runSmokeTest() must take a before snapshot, call step() with empty input, take an after snapshot, and assert after.distanceTraveled > before.distanceTraveled.',
    hints: [
      'Runner runSmokeTest template: const before = snapshot(); step("", 24); const after = snapshot(); assert(after.distanceTraveled > before.distanceTraveled, "auto-run failed"); step("Space", 12); assert(snapshot().obstaclesAvoided > after.obstaclesAvoided, "jump dodge failed").',
      'If your engine ties motion to keyboard, refactor: forward speed should come from a runSpeed constant integrated each frame, not from ArrowRight handling.',
    ],
  },
];

const ENTRY_BY_CODE: ReadonlyMap<RunnerRepairCode, RunnerRepairEntry> = new Map(
  RUNNER_REPAIR_CODES.map((entry) => [entry.code, entry]),
);

export function lookupRunnerRepair(code: string): RunnerRepairEntry | undefined {
  return ENTRY_BY_CODE.get(code as RunnerRepairCode);
}

export function classifyRunnerFailure(text: string): RunnerRepairEntry | undefined {
  for (const entry of RUNNER_REPAIR_CODES) {
    if (entry.pattern.test(text)) return entry;
  }
  return undefined;
}

export const RUNNER_REPAIR_CODE_SET: ReadonlySet<RunnerRepairCode> = new Set(
  RUNNER_REPAIR_CODES.map((entry) => entry.code),
);
