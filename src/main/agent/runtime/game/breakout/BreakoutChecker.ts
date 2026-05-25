/** BreakoutChecker — breakout / arkanoid subtype validation. */
import path from 'path';

import type {
  GameSubtypeChecker,
  MechanicsResult,
  RuntimeEvidenceResult,
  Snapshot,
  SmokeResult,
  SubtypeContext,
  VerbDeclaration,
} from '../types';
import { gameSubtypeRegistry } from '../registry';
import { extractByPath } from '../verbs';

const BREAKOUT_ALIASES = ['breakout', 'arkanoid'] as const;
const REQUIRED_POWERUPS = ['wide', 'multi', 'slow', 'through', 'life'] as const;
const REQUIRED_SCENARIOS = [
  'paddleMove',
  'launch',
  'wallBounce',
  'paddleBounce',
  'brickHit',
  'win',
  'lose',
] as const;

const BREAKOUT_META_PATTERN =
  /__(?:GAME|INTERACTIVE)_META__[\s\S]{0,3000}\b(?:subtype|genre|type)\s*:\s*['"`](?:breakout|arkanoid)['"`]|(?:game|interactive)-meta[\s\S]{0,3000}"(?:subtype|genre|type)"\s*:\s*"(?:breakout|arkanoid)"/i;

const DECLARED_VERBS: readonly VerbDeclaration[] = [
  { verb: 'moveTo', selector: 'paddleX', successPredicate: { op: 'change', path: 'paddleX' }, required: true },
  { verb: 'traverse', selector: 'ball.y', successPredicate: { op: 'change', path: 'ball.y' }, required: true },
  { verb: 'defeat', selector: 'brickCount', successPredicate: { op: 'decrease', path: 'brickCount' }, required: true },
  { verb: 'collect', selector: 'powerupsTriggered.length', successPredicate: { op: 'increase', path: 'powerupsTriggered.length' }, required: true },
  { verb: 'complete', selector: 'status', successPredicate: { op: 'matches', path: 'status', pattern: 'won|win|complete|cleared' }, required: true },
  { verb: 'fail', selector: 'status', successPredicate: { op: 'matches', path: 'status', pattern: 'lost|lose|failed|gameover' }, required: true },
];

type ScenarioProbe = {
  name?: unknown;
  before?: unknown;
  after?: unknown;
  error?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textFrom(value: unknown): string {
  try {
    return JSON.stringify(value || {}).toLowerCase();
  } catch {
    return String(value || '').toLowerCase();
  }
}

function listFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,\n|]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function coverageList(coverage: unknown, key: string): string[] {
  return isPlainObject(coverage) ? listFrom(coverage[key]) : [];
}

function coverageFlag(coverage: unknown, key: string): boolean {
  return isPlainObject(coverage) && coverage[key] === true;
}

function coverageNumber(coverage: unknown, key: string): number | undefined {
  const value = isPlainObject(coverage) ? coverage[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function smokeCheckIncludes(smoke: SmokeResult, pattern: RegExp): boolean {
  return smoke.passed === true && smoke.checks.some((check) => pattern.test(String(check || '').toLowerCase()));
}

function allAuthoredScenariosCovered(coverage: unknown): boolean {
  if (coverageFlag(coverage, 'allLevelsReachable')) return true;
  const levelsPassed = coverageNumber(coverage, 'levelsPassed');
  const totalLevels = coverageNumber(coverage, 'totalLevels');
  return typeof levelsPassed === 'number' && typeof totalLevels === 'number' && totalLevels > 0 && levelsPassed >= totalLevels;
}

function coverageIncludes(coverage: unknown, key: string, pattern: RegExp): boolean {
  return coverageList(coverage, key).some((item) => pattern.test(item));
}

function readNumber(snapshot: unknown, paths: readonly string[], keyPatterns: readonly RegExp[] = []): number | undefined {
  for (const metricPath of paths) {
    const value = extractByPath(snapshot, metricPath);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }

  let found: number | undefined;
  const visit = (current: unknown, key = ''): void => {
    if (typeof found === 'number') return;
    if (typeof current === 'number' && keyPatterns.some((pattern) => pattern.test(key))) {
      found = current;
      return;
    }
    if (!isPlainObject(current) && !Array.isArray(current)) return;
    for (const [childKey, childValue] of Object.entries(current as Record<string, unknown>)) {
      visit(childValue, childKey);
    }
  };
  visit(snapshot);
  return found;
}

function numberIncreased(before: unknown, after: unknown, paths: readonly string[], keyPatterns: readonly RegExp[] = []): boolean {
  const beforeValue = readNumber(before, paths, keyPatterns);
  const afterValue = readNumber(after, paths, keyPatterns);
  return typeof beforeValue === 'number' && typeof afterValue === 'number' && afterValue > beforeValue;
}

function numberDecreased(before: unknown, after: unknown, paths: readonly string[], keyPatterns: readonly RegExp[] = []): boolean {
  const beforeValue = readNumber(before, paths, keyPatterns);
  const afterValue = readNumber(after, paths, keyPatterns);
  return typeof beforeValue === 'number' && typeof afterValue === 'number' && afterValue < beforeValue;
}

function numberChanged(before: unknown, after: unknown, paths: readonly string[], keyPatterns: readonly RegExp[] = []): boolean {
  const beforeValue = readNumber(before, paths, keyPatterns);
  const afterValue = readNumber(after, paths, keyPatterns);
  return typeof beforeValue === 'number'
    && typeof afterValue === 'number'
    && !Object.is(beforeValue, afterValue);
}

function readString(snapshot: unknown, paths: readonly string[]): string {
  for (const metricPath of paths) {
    const value = extractByPath(snapshot, metricPath);
    if (typeof value === 'string') return value.toLowerCase();
  }
  return '';
}

function hasTruthy(snapshot: unknown, paths: readonly string[]): boolean {
  return paths.some((metricPath) => Boolean(extractByPath(snapshot, metricPath)));
}

function getBreakoutScenarioProbes(observations: unknown): ScenarioProbe[] {
  if (Array.isArray(observations)) return [];
  if (!isPlainObject(observations)) return [];
  const direct = observations.breakoutScenarios;
  if (Array.isArray(direct)) return direct.filter(isPlainObject) as ScenarioProbe[];
  const nested = isPlainObject(observations.subtype) ? observations.subtype.breakoutScenarios : undefined;
  return Array.isArray(nested) ? nested.filter(isPlainObject) as ScenarioProbe[] : [];
}

function findScenario(probes: readonly ScenarioProbe[], name: string): ScenarioProbe | undefined {
  const normalizedName = name.toLowerCase();
  return probes.find((probe) => String(probe.name || '').toLowerCase() === normalizedName);
}

function hasWon(snapshot: unknown): boolean {
  const status = readString(snapshot, ['status', 'state', 'mode', 'game.status', 'gameState']);
  return /won|win|complete|cleared|success/.test(status)
    || hasTruthy(snapshot, ['won', 'gameWon', 'levelComplete', 'complete', 'victory']);
}

function hasLost(snapshot: unknown): boolean {
  const status = readString(snapshot, ['status', 'state', 'mode', 'game.status', 'gameState']);
  const lives = readNumber(snapshot, ['lives', 'player.lives', 'state.lives']);
  return /lost|lose|failed|dead|gameover|game-over/.test(status)
    || hasTruthy(snapshot, ['lost', 'gameOver', 'failed', 'player.dead'])
    || lives === 0;
}

function powerupTriggered(type: typeof REQUIRED_POWERUPS[number], probe: ScenarioProbe | undefined): boolean {
  if (!probe) return false;
  const before = probe.before;
  const after = probe.after;
  const afterText = textFrom(after);
  const mentionsType = afterText.includes(type);

  if (type === 'wide') {
    return numberIncreased(before, after, ['paddle.width', 'paddleWidth'], [/paddlewidth/i])
      || mentionsType;
  }
  if (type === 'multi') {
    return numberIncreased(before, after, ['ballCount', 'balls.length'], [/ballcount|balls/i])
      || mentionsType;
  }
  if (type === 'slow') {
    return numberDecreased(before, after, ['ball.speed', 'ballSpeed', 'speed'], [/ballspeed|speed/i])
      || mentionsType;
  }
  if (type === 'through') {
    return hasTruthy(after, ['through', 'ball.through', 'throughActive', 'powerups.through', 'activePowerups.through'])
      || mentionsType;
  }
  return numberIncreased(before, after, ['lives', 'player.lives', 'state.lives'], [/lives/i])
    || mentionsType;
}

export function isBreakoutArtifact(content: string, filePath = ''): boolean {
  if (BREAKOUT_META_PATTERN.test(content)) return true;
  return /\b(?:breakout|arkanoid)\b/i.test(path.basename(filePath))
    && /window\.__(?:GAME|INTERACTIVE)_META__/i.test(content);
}

export class BreakoutChecker implements GameSubtypeChecker {
  readonly subtype: string;
  readonly declaredVerbs = DECLARED_VERBS;

  constructor(subtype: string = 'breakout') {
    this.subtype = subtype;
  }

  validateMechanics(snippet: string, ctx: SubtypeContext): MechanicsResult {
    const filePath = typeof ctx.metadata?.filePath === 'string' ? ctx.metadata.filePath : '';
    if (!isBreakoutArtifact(snippet, filePath)) {
      return { passed: true, failures: [], checks: [] };
    }

    const failures: string[] = [];
    const checks: string[] = ['breakout subtype contract applies'];

    if (!/\bpaddleX\b|\bpaddle\s*[:=]\s*\{[\s\S]{0,500}\bx\s*:/i.test(snippet)) {
      failures.push('breakout 缺少 paddleX 可观测状态；snapshot() 必须暴露 paddleX 或 paddle.x，并且左右输入会改变它。');
    } else {
      checks.push('breakout paddle state declared');
    }

    if (!/\bball\b[\s\S]{0,900}\b(?:vx|vy|dx|dy|speed)\b/i.test(snippet)) {
      failures.push('breakout 缺少 ball 坐标/速度状态；snapshot() 必须暴露 ball.x/y 与 vx/vy 或 speed，launch 后坐标要变化。');
    } else {
      checks.push('breakout ball movement state declared');
    }

    if (!/\bwallBounceCount\b/i.test(snippet)) {
      failures.push('breakout 缺少 wallBounceCount；墙面反弹必须增加可观测 counter。');
    } else {
      checks.push('breakout wallBounceCount declared');
    }

    if (!/\bpaddleBounceCount\b/i.test(snippet)) {
      failures.push('breakout 缺少 paddleBounceCount；挡板反弹必须增加可观测 counter。');
    } else {
      checks.push('breakout paddleBounceCount declared');
    }

    if (!/\b(?:brickCount|bricksRemaining)\b/i.test(snippet) || !/\bscore\b/i.test(snippet)) {
      failures.push('breakout 缺少 brickCount/bricksRemaining 与 score；击中砖块必须让砖块数减少并让 score 增加。');
    } else {
      checks.push('breakout brick and score counters declared');
    }

    const missingPowerups = REQUIRED_POWERUPS.filter((type) => !new RegExp(`\\b${type}\\b`, 'i').test(snippet));
    if (missingPowerups.length > 0) {
      failures.push(`breakout 缺少 powerups: ${missingPowerups.join(', ')}；wide/multi/slow/through/life 至少要可触发并可观测。`);
    } else {
      checks.push('breakout required powerups declared');
    }

    const missingScenarios = REQUIRED_SCENARIOS.filter((scenario) => !new RegExp(`['"\`]${scenario}['"\`]`, 'i').test(snippet));
    const missingPowerupScenarios = REQUIRED_POWERUPS
      .map((type) => `powerup:${type}`)
      .filter((scenario) => !new RegExp(`['"\`]${scenario}['"\`]`, 'i').test(snippet));
    if (missingScenarios.length > 0 || missingPowerupScenarios.length > 0) {
      failures.push(`breakout 缺少 deterministic reset scenario: ${[...missingScenarios, ...missingPowerupScenarios].join(', ')}；reset(scenario) 必须能把球/砖块/道具放到可验证位置。`);
    } else {
      checks.push('breakout deterministic reset scenarios declared');
    }

    return { passed: failures.length === 0, failures, checks };
  }

  validateRuntimeEvidence(
    beforeSnap: Snapshot,
    afterSnap: Snapshot,
    smoke: SmokeResult,
    ctx: SubtypeContext,
  ): RuntimeEvidenceResult {
    const failures: string[] = [];
    const checks: string[] = [];
    const runtimeMeta = ctx.metadata as { observations?: unknown; coverage?: unknown } | undefined;
    const coverage = runtimeMeta?.coverage;
    const probes = getBreakoutScenarioProbes(runtimeMeta?.observations);
    const evidenceText = textFrom([runtimeMeta?.coverage, runtimeMeta?.observations, smoke.checks]);

    const paddleProbe = findScenario(probes, 'paddleMove');
    if (paddleProbe && numberChanged(paddleProbe.before, paddleProbe.after, ['paddleX', 'paddle.x'], [/paddlex|^x$/i])) {
      checks.push('breakout runtime moved paddleX via declared controls');
    } else if (numberChanged(beforeSnap, afterSnap, ['paddleX', 'paddle.x'], [/paddlex/i])) {
      checks.push('breakout runtime moved paddleX in smoke snapshot');
    } else {
      failures.push('breakout runtime 缺少 paddle 证据：reset("paddleMove") 后 step({ArrowRight/right}, frames) 必须改变 paddleX。');
    }

    const browserLaunchProbe = findScenario(probes, 'browserLaunchFromStart');
    if (browserLaunchProbe && (
      numberChanged(browserLaunchProbe.before, browserLaunchProbe.after, ['ball.x', 'ballX', 'balls[0].x'], [/ballx|^x$/i]) ||
      numberChanged(browserLaunchProbe.before, browserLaunchProbe.after, ['ball.y', 'ballY', 'balls[0].y'], [/bally|^y$/i])
    )) {
      checks.push('breakout runtime browser Space launch moved ball from start state');
    } else {
      failures.push('breakout runtime 缺少真实 Space 发球证据：从默认开始状态派发浏览器 Space 键盘事件后，ball.x 或 ball.y 必须变化。不能只让 reset("launch") 预先把球设成已发射。');
    }

    const launchProbe = findScenario(probes, 'launch');
    if (launchProbe && (
      numberChanged(launchProbe.before, launchProbe.after, ['ball.x', 'ballX', 'balls[0].x'], [/ballx|^x$/i]) ||
      numberChanged(launchProbe.before, launchProbe.after, ['ball.y', 'ballY', 'balls[0].y'], [/bally|^y$/i])
    )) {
      checks.push('breakout deterministic launch scenario moved ball coordinates');
    }

    const wallProbe = findScenario(probes, 'wallBounce');
    if (wallProbe && numberIncreased(wallProbe.before, wallProbe.after, ['wallBounceCount'], [/wallbouncecount/i])) {
      checks.push('breakout runtime increased wallBounceCount');
    } else if (
      smokeCheckIncludes(smoke, /\bwallbounce(?:count)?\b/i) &&
      coverageIncludes(coverage, 'mechanics', /\bwallbounce\b/i) &&
      coverageIncludes(coverage, 'stateChanges', /\bwallbouncecount\b/i)
    ) {
      checks.push('breakout runtime covered wallBounceCount via runSmokeTest coverage');
    } else {
      failures.push('breakout runtime 缺少 wallBounceCount 证据：reset("wallBounce") 后 step 若干帧必须让 wallBounceCount > before。');
    }

    const paddleBounceProbe = findScenario(probes, 'paddleBounce');
    if (paddleBounceProbe && numberIncreased(paddleBounceProbe.before, paddleBounceProbe.after, ['paddleBounceCount'], [/paddlebouncecount/i])) {
      checks.push('breakout runtime increased paddleBounceCount');
    } else {
      failures.push('breakout runtime 缺少 paddleBounceCount 证据：reset("paddleBounce") 后球碰挡板必须增加 paddleBounceCount。');
    }

    const brickProbe = findScenario(probes, 'brickHit');
    const brickHit =
      brickProbe &&
      (
        numberDecreased(brickProbe.before, brickProbe.after, ['brickCount', 'bricksRemaining'], [/brickcount|bricksremaining/i]) ||
        numberIncreased(brickProbe.before, brickProbe.after, ['score'], [/score/i])
      );
    if (brickHit) {
      checks.push('breakout runtime hit brick with brickCount/score delta');
    } else {
      failures.push('breakout runtime 缺少 brick hit 证据：reset("brickHit") 后 brickCount/bricksRemaining 必须下降，或 score 必须增加。');
    }

    const missingRuntimePowerups = REQUIRED_POWERUPS.filter((type) => {
      const probe = findScenario(probes, `powerup:${type}`);
      return !powerupTriggered(type, probe) && !new RegExp(`\\b${type}\\b`).test(evidenceText);
    });
    if (missingRuntimePowerups.length > 0) {
      failures.push(`breakout runtime 缺少 powerup 触发证据: ${missingRuntimePowerups.join(', ')}；每个 powerup:<type> scenario 都要产生 snapshot delta 或 active powerup 状态。`);
    } else {
      checks.push('breakout runtime covered wide/multi/slow/through/life powerups');
    }

    const winProbe = findScenario(probes, 'win');
    if (
      (winProbe && (hasWon(winProbe.after) || hasWon(winProbe.before)))
      || /\bwin\b[\s\S]{0,80}\b(?:won|complete|cleared|success)\b/i.test(evidenceText)
      || (
        smokeCheckIncludes(smoke, /\bwin\b/i) &&
        allAuthoredScenariosCovered(coverage) &&
        coverageIncludes(coverage, 'stateChanges', /\bstatus\b/i)
      )
    ) {
      checks.push('breakout runtime reached won state');
    } else {
      failures.push('breakout runtime 缺少 win 证据：reset("win") 的 deterministic scenario 必须到达 won/win/complete/cleared 状态。');
    }

    const loseProbe = findScenario(probes, 'lose');
    if (
      (loseProbe && (hasLost(loseProbe.after) || hasLost(loseProbe.before)))
      || /\blose\b[\s\S]{0,80}\b(?:lost|gameover|game over|lives is 0)\b/i.test(evidenceText)
      || (
        smokeCheckIncludes(smoke, /\blose\b/i) &&
        allAuthoredScenariosCovered(coverage) &&
        coverageIncludes(coverage, 'stateChanges', /\b(?:status|lives)\b/i) &&
        coverageIncludes(coverage, 'risks', /\b(?:lose|lost|gameover|game over|loselife)\b/i)
      )
    ) {
      checks.push('breakout runtime reached lost state');
    } else {
      failures.push('breakout runtime 缺少 lose 证据：reset("lose") 的 deterministic scenario 必须到达 lost/gameOver 或 lives=0。');
    }

    return { passed: failures.length === 0, failures, checks };
  }

  repairGuidance(failureCode: string): string | undefined {
    if (/breakout|arkanoid/i.test(failureCode)) {
      return 'Expose breakout/arkanoid __GAME_META__ and __GAME_TEST__ deterministic scenarios for paddleMove, launch, wallBounce, paddleBounce, brickHit, powerup:<type>, win, and lose; each scenario must be driven by live step() and produce before/after snapshot deltas. Start the real browser game loop with requestAnimationFrame(loop) or equivalent before the script exits. Wire real browser keyboard events too: Space must use event.code === "Space" or normalize event.key === " " to the same Space input consumed by the live loop, and a real browser Space press from the start screen must move ball.x or ball.y.';
    }
    return undefined;
  }
}

export const breakoutChecker = new BreakoutChecker('breakout');
export const arkanoidChecker = new BreakoutChecker('arkanoid');

gameSubtypeRegistry.register(breakoutChecker);
gameSubtypeRegistry.register(arkanoidChecker);
