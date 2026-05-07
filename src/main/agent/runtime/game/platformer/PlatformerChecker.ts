/**
 * PlatformerChecker — Phase 2 task C 的产物。
 *
 * 把 `gameArtifactValidator.ts` 里所有 platformer-aware 的断言搬到这里：
 * - `validateMechanics` ← 原 `validatePlatformerGameplayMechanics()`（静态 snippet 检查）
 * - `validateRuntimeEvidence` ← 原 page.evaluate 内 `validatePlatformerGameplayRuntimeEvidence`
 *   （JS 写在 string literal 里，现在 port 成 TS，配套搬过来 readMetric/listFrom/textFrom 等
 *   工具函数）
 * - `repairGuidance` ← 原 `artifactRepairSpec.ts` 里 platformer-specific 的失败码 → repair instruction
 *
 * 设计原则：**byte-for-byte 行为不变**。失败文案、判断逻辑、正则全部沿用原版；
 * 只是从 string literal/巨型 if-else 抽到声明式结构里。
 */

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
// side-effect — platformer scope guards 在被 import 时自注册到 scopeGuardRegistry
import '../../repair/platformerScopeGuards';
import {
  PLATFORMER_REPAIR_CODES,
  classifyPlatformerFailure,
  lookupPlatformerRepair,
  PLATFORMER_REPAIR_CODE_SET,
  type PlatformerRepairCode,
} from './repairCodes';

// ---------------------------------------------------------------------------
// 静态 metadata 检测（原 isPlatformerArtifact / validatePlatformerGameplayMechanics）
// ---------------------------------------------------------------------------

const PLATFORMER_META_PATTERNS = [
  /__(?:GAME|INTERACTIVE)_META__[\s\S]{0,2500}\b(?:subtype|genre|type)\s*:\s*['"`]platformer['"`]/i,
  /(?:game|interactive)-meta[\s\S]{0,2500}"(?:subtype|genre|type)"\s*:\s*"platformer"/i,
];

const PLATFORMER_ABILITY_PATTERN =
  /\b(doubleJump|double-jump|dash|shield|magnet|groundPound|ground-pound|wallJump|wall-jump)\b/i;

/** 平台游戏 mechanics 数组的 5 个必填字段 */
const REQUIRED_MECHANICS_FIELDS = ['enemies', 'blocks', 'abilities', 'gates', 'comboChallenge'] as const;

function findBalancedObjectAssignmentSnippet(
  content: string,
  assignmentPattern: RegExp,
): string | null {
  const match = assignmentPattern.exec(content);
  if (!match) return null;
  const start = match.index;
  let openBrace = -1;
  for (let index = Math.max(0, start); index < content.length; index += 1) {
    const ch = content[index];
    if (ch === '{') {
      openBrace = index;
      break;
    }
    if (ch === ';' || (ch === '\n' && index - start > 500)) break;
  }
  if (openBrace < 0) return null;

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openBrace; index < content.length; index += 1) {
    const ch = content[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        while (/\s/.test(content[end] || '')) end += 1;
        if (content[end] === ';') end += 1;
        return content.slice(start, end);
      }
    }
  }
  return null;
}

function extractGameMetadataSnippet(content: string): string | null {
  return (
    findBalancedObjectAssignmentSnippet(content, /window\.__GAME_META__\s*=\s*\{/i) ||
    findBalancedObjectAssignmentSnippet(content, /window\.__INTERACTIVE_META__\s*=\s*\{/i)
  );
}

/**
 * 原 `isPlatformerArtifact()` 的 TS 版本 — 判断 artifact 是否要走平台游戏验收。
 * 调用点保留在 validator 主入口，作为 dispatch 之前的 gating。
 */
export function isPlatformerArtifact(content: string, filePath: string): boolean {
  const metadataSnippet = extractGameMetadataSnippet(content) ?? content;
  if (PLATFORMER_META_PATTERNS.some((pattern) => pattern.test(metadataSnippet))) {
    return true;
  }
  if (
    /\bplatformer\b/i.test(path.basename(filePath)) &&
    /window\.__(?:GAME|INTERACTIVE)_META__/i.test(content)
  ) {
    return true;
  }
  return false;
}

function hasGameplayMechanicsArray(snippet: string, field: string): boolean {
  return new RegExp(`["']?${field}["']?\\s*:\\s*\\[`, 'i').test(snippet);
}

function countComboAxes(snippet: string): number {
  return [
    /\b(?:stomp|stompable|enemy|enemies)\b/i,
    /\b(?:block|blocks|bump|question)\b/i,
    PLATFORMER_ABILITY_PATTERN,
    /\b(?:gate|route|unlock)\b/i,
  ].filter((pattern) => pattern.test(snippet)).length;
}

// ---------------------------------------------------------------------------
// 运行时证据（原 page.evaluate 内 validatePlatformerGameplayRuntimeEvidence）
// ---------------------------------------------------------------------------

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

function isNegativeEvidence(value: unknown): boolean {
  return /(?:^|[\s:,[({=;-])(?:false|fail|failed|failure|missing|not|none|no)(?:$|[\s:,\])}.!;=-])|缺少|失败|未通过|没有|不能|无法/i.test(
    String(value || '').toLowerCase(),
  );
}

function listFrom(value: unknown, keyPath = ''): string[] {
  if (value === null || typeof value === 'undefined') return [];
  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .flatMap((item) => listFrom(item, keyPath));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.flatMap(([key, childValue]) => {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      if (childValue === true) return [childPath];
      if (childValue === false || childValue === null || typeof childValue === 'undefined') return [];
      return listFrom(childValue, childPath);
    });
  }
  if (typeof value === 'boolean') return value ? (keyPath ? [keyPath] : ['true']) : [];
  return [String(value)];
}

function readMetric(snapshot: unknown, key: string): unknown {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const normalized = String(key).replace(/\[(\d+)\]/g, '.$1');
  return normalized.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, snapshot);
}

function findNumericValue(value: unknown, keyPatterns: readonly RegExp[]): number {
  let found: number | undefined;
  const visit = (current: unknown, key = ''): void => {
    if (typeof found === 'number') return;
    if (typeof current === 'number' && keyPatterns.some((pattern) => pattern.test(key))) {
      found = current;
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [childKey, childValue] of Object.entries(current as Record<string, unknown>)) {
      visit(childValue, childKey);
    }
  };
  visit(value);
  return typeof found === 'number' ? found : 0;
}

function countMatchingObjects(
  value: unknown,
  predicate: (object: Record<string, unknown>, key: string) => boolean,
): number {
  let count = 0;
  const visit = (current: unknown, key = ''): void => {
    if (!current || typeof current !== 'object') return;
    if (predicate(current as Record<string, unknown>, key)) count += 1;
    for (const [childKey, childValue] of Object.entries(current as Record<string, unknown>)) {
      visit(childValue, childKey);
    }
  };
  visit(value);
  return count;
}

function countDefeatedEnemies(snapshot: unknown): number {
  return countMatchingObjects(snapshot, (object, key) => {
    const objectText = textFrom(object);
    const keyText = String(key).toLowerCase();
    const enemyish = /enemy|enemies|stomp/.test(`${keyText} ${objectText}`);
    if (!enemyish) return false;
    return (
      object.defeated === true ||
      object.stomped === true ||
      object.alive === false ||
      /defeated|stomped|squashed/.test(String(object.state || object.status || '').toLowerCase())
    );
  });
}

function countUsedBlocks(snapshot: unknown): number {
  return countMatchingObjects(snapshot, (object, key) => {
    const objectText = textFrom(object);
    const keyText = String(key).toLowerCase();
    const blockish = /block|brick|question/.test(`${keyText} ${objectText}`);
    if (!blockish) return false;
    return (
      object.used === true ||
      object.broken === true ||
      object.bumped === true ||
      /used|broken|bumped|empty/.test(String(object.state || object.status || '').toLowerCase())
    );
  });
}

function countOpenGates(snapshot: unknown): number {
  return countMatchingObjects(snapshot, (object, key) => {
    const objectText = textFrom(object);
    const keyText = String(key).toLowerCase();
    const gateish = /gate|door|route/.test(`${keyText} ${objectText}`);
    if (!gateish) return false;
    return (
      object.open === true ||
      object.unlocked === true ||
      object.reachable === true ||
      /open|unlocked|reachable|passed/.test(
        String(object.state || object.status || '').toLowerCase(),
      )
    );
  });
}

function snapshotAbilities(snapshot: unknown): unknown {
  const playerAbilities = readMetric(snapshot, 'player.abilities');
  if (typeof playerAbilities !== 'undefined') return playerAbilities;
  return readMetric(snapshot, 'abilities');
}

function collectEvidenceStrings(
  smoke: SmokeResult | undefined,
  coverage: unknown,
  observations: unknown,
): string {
  if (smoke?.passed !== true) return '';
  const cov = isPlainObject(coverage) ? coverage : {};
  return [
    ...listFrom(cov.mechanics),
    ...listFrom(cov.rewards),
    ...listFrom(cov.risks),
    ...listFrom(cov.stateChanges),
    ...listFrom(cov.gameplayMechanics),
    ...listFrom(cov.mechanicsEvidence),
    ...listFrom(smoke.checks),
    ...listFrom(observations),
  ]
    .filter((item) => !isNegativeEvidence(item))
    .join(' | ')
    .toLowerCase();
}

/**
 * Platformer 运行时上下文 — `gameArtifactValidator` 在 page.evaluate 之后传过来。
 *
 * 字段都来自原 inline JS 函数的入参；保留 `gameplayMechanics` / `coverage` / `meta` 等
 * 形参，方便审稿对照。
 */
export interface PlatformerRuntimeContext {
  /** 整个 __GAME_META__ / __INTERACTIVE_META__ — `meta.gameplayMechanics` 是必读字段 */
  meta?: Record<string, unknown>;
  /** smoke.coverage — 既包含 mechanics/rewards/risks 也包含 stateChanges */
  coverage?: unknown;
  /** smoke.observations — runSmokeTest 自报的额外证据字符串，作为 evidence 来源之一 */
  observations?: unknown;
}

// ---------------------------------------------------------------------------
// PlatformerChecker
// ---------------------------------------------------------------------------

const DECLARED_VERBS: readonly VerbDeclaration[] = [
  // platformer 的 stomp 是 defeat 的特化 — selector 指向 enemiesDefeated 计数
  {
    verb: 'defeat',
    selector: 'enemiesDefeated',
    successPredicate: { op: 'increase', path: 'enemiesDefeated' },
    required: true,
  },
  // bumpBlock 是 collect 的特化 — block 击中后 blocksUsed 增加
  {
    verb: 'collect',
    selector: 'blocksUsed',
    successPredicate: { op: 'increase', path: 'blocksUsed' },
    required: true,
  },
  // gate 解锁
  {
    verb: 'unlock',
    selector: 'gatesUnlocked',
    successPredicate: { op: 'increase', path: 'gatesUnlocked' },
    required: true,
  },
  // 玩家位移 — moveTo 看 player.x 任意变化
  {
    verb: 'moveTo',
    selector: 'player.x',
    successPredicate: { op: 'change', path: 'player.x' },
    required: true,
  },
  // combo 挑战覆盖（traverse） — 看 coverage.comboChallenge truthy
  {
    verb: 'traverse',
    selector: 'comboChallenge',
    successPredicate: { op: 'truthy', path: 'coverage.comboChallenge' },
    required: false,
  },
];

export class PlatformerChecker implements GameSubtypeChecker {
  readonly subtype = 'platformer';
  readonly declaredVerbs = DECLARED_VERBS;

  validateMechanics(
    snippet: string,
    ctx: SubtypeContext,
  ): MechanicsResult {
    // ctx.metadata?.filePath 透传 — 静态检查需要 file 名做 fallback 识别
    const filePath = (ctx.metadata?.filePath as string | undefined) ?? '';
    if (!isPlatformerArtifact(snippet, filePath)) {
      return { passed: true, failures: [], checks: [] };
    }

    const failures: string[] = [];
    const checks: string[] = ['platformer gameplay mechanics contract applies'];
    const metadataSnippet = extractGameMetadataSnippet(snippet) ?? snippet;
    const gameplayIndex = metadataSnippet.search(/\bgameplayMechanics\b/i);
    const gameplaySnippet =
      gameplayIndex >= 0
        ? metadataSnippet.slice(gameplayIndex, Math.min(metadataSnippet.length, gameplayIndex + 7000))
        : '';

    if (!gameplaySnippet) {
      failures.push(
        'platformer 缺少 gameplayMechanics 元数据；请在 __GAME_META__ 中声明并实现 enemies、blocks、abilities、gates、comboChallenge。',
      );
      return { passed: failures.length === 0, failures, checks };
    }

    checks.push('platformer gameplayMechanics metadata detected');

    for (const field of REQUIRED_MECHANICS_FIELDS) {
      if (!hasGameplayMechanicsArray(gameplaySnippet, field)) {
        failures.push(
          `platformer gameplayMechanics 缺少 ${field} 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge，单个机制也要写成数组，不能写成对象 map。`,
        );
      }
    }

    if (
      !/\benemies\b[\s\S]{0,1800}(?:\bstompable\s*:\s*true|["']stompable["']\s*:\s*true|\bstomp\b|stompableEnemy)/i.test(
        gameplaySnippet,
      )
    ) {
      failures.push(
        'platformer gameplayMechanics.enemies 缺少 stompable enemy；请添加可踩踏敌人，并让踩踏改变 enemy defeated 状态与玩家 bounce/vy。',
      );
    }

    if (
      !/\bblocks\b[\s\S]{0,1800}(?:\bbumpableFromBelow\s*:\s*true|["']bumpableFromBelow["']\s*:\s*true|\bbumpable\b|\bquestion\b|questionBlock)/i.test(
        gameplaySnippet,
      )
    ) {
      failures.push(
        'platformer gameplayMechanics.blocks 缺少 bumpable/question block；请添加可从下方顶起的砖块，并产生 used/broken/reward 状态。',
      );
    }

    if (
      !/\babilities\b[\s\S]{0,2200}/i.test(gameplaySnippet) ||
      !PLATFORMER_ABILITY_PATTERN.test(gameplaySnippet)
    ) {
      failures.push(
        'platformer gameplayMechanics.abilities 缺少改变规则的技能；至少添加 doubleJump、dash、shield、magnet、groundPound 或 wallJump 之一。',
      );
    }

    if (!/\babilities\b[\s\S]{0,2200}\b(?:effect|unlocksRoute|acquiredFrom)\b/i.test(gameplaySnippet)) {
      failures.push(
        'platformer gameplayMechanics.abilities 缺少 acquiredFrom/effect/unlocksRoute；技能必须说明来源、效果以及它改变哪条路线或交互规则。',
      );
    }

    if (!/\bgates\b[\s\S]{0,1800}\brequiresAbility\b[\s\S]{0,900}\bblocksAccessTo\b/i.test(gameplaySnippet)) {
      failures.push(
        'platformer gameplayMechanics.gates 缺少 requiresAbility 和 blocksAccessTo；至少有一段区域必须通过技能或奖励才能到达或通过。',
      );
    }

    const comboMatch = /\bcomboChallenge\b[\s\S]{0,2200}/i.exec(gameplaySnippet);
    const comboSnippet = comboMatch?.[0] || '';
    if (!/\bjump\b/i.test(comboSnippet) || countComboAxes(comboSnippet) < 2) {
      failures.push(
        'platformer gameplayMechanics.comboChallenge 必须组合 jump，并至少再组合 stomp/enemy、block bump、ability 或 gate route 中的两类。',
      );
    }

    return { passed: failures.length === 0, failures, checks };
  }

  /**
   * Step input shape check — 平台游戏的 step(inputState, frames) 应该接受
   * 元数据声明的语义控制名加真实键码。当前实现是 no-op：原 validator 主入口
   * 已经通过 `validateTestContractIntegrity` 覆盖了通用 step 完整性，这里
   * 留接口保持任务 spec 一致，未来扩展平台游戏专属 step 形态校验时挂到这里。
   */
  validateStepInputShapes(_content: string): { failures: string[]; checks: string[] } {
    return { failures: [], checks: [] };
  }

  validateRuntimeEvidence(
    beforeSnap: Snapshot,
    afterSnap: Snapshot,
    smoke: SmokeResult,
    ctx: SubtypeContext,
  ): RuntimeEvidenceResult {
    const failures: string[] = [];
    const checks: string[] = [];

    // 跨进程边界传过来的 platformer 上下文 — meta.gameplayMechanics + coverage
    const runtimeMeta = (ctx.metadata as PlatformerRuntimeContext | undefined) ?? {};
    const meta = runtimeMeta.meta ?? {};
    const gameplayMechanics = (meta as Record<string, unknown>).gameplayMechanics;
    if (!isPlainObject(gameplayMechanics)) {
      // 与原 inline 函数保持一致：非 object 直接 return（不报错也不打 check）
      return { passed: true, failures, checks };
    }
    const coverage = runtimeMeta.coverage;
    const observations = runtimeMeta.observations;
    const evidence = collectEvidenceStrings(smoke, coverage, observations);
    const hasEvidence = (patterns: readonly RegExp[]): boolean =>
      patterns.some((pattern) => pattern.test(evidence));

    // ----- stompable enemy -----
    const enemyDelta =
      findNumericValue(afterSnap, [
        /enemiesdefeated/i,
        /defeatedenemies/i,
        /stompedenemies/i,
        /^stomps?$/i,
      ]) >
        findNumericValue(beforeSnap, [
          /enemiesdefeated/i,
          /defeatedenemies/i,
          /stompedenemies/i,
          /^stomps?$/i,
        ]) ||
      countDefeatedEnemies(afterSnap) > countDefeatedEnemies(beforeSnap) ||
      hasEvidence([/stomp/, /enemy[_ -]?defeat/, /defeated[_ -]?enemy/]);
    const bounceEvidence =
      JSON.stringify(readMetric(beforeSnap, 'player.vy')) !==
        JSON.stringify(readMetric(afterSnap, 'player.vy')) ||
      hasEvidence([/bounce/, /stomp[_ -]?bounce/, /\bvy\b/, /vertical[_ -]?velocity/]);
    if (enemyDelta && bounceEvidence) {
      checks.push(
        'platformer gameplay runtime covered stompable enemy with defeated/bounce evidence',
      );
    } else {
      failures.push(
        'platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。',
      );
    }

    // ----- bumpable block -----
    const blockDelta =
      findNumericValue(afterSnap, [
        /blocksbumped/i,
        /blocksused/i,
        /blockhits/i,
        /spawnedrewards/i,
      ]) >
        findNumericValue(beforeSnap, [
          /blocksbumped/i,
          /blocksused/i,
          /blockhits/i,
          /spawnedrewards/i,
        ]) ||
      countUsedBlocks(afterSnap) > countUsedBlocks(beforeSnap) ||
      hasEvidence([
        /bump[_ -]?block/,
        /question[_ -]?block/,
        /block[_ -]?(used|broken|bumped)/,
        /spawned[_ -]?reward/,
      ]);
    if (blockDelta) {
      checks.push('platformer gameplay runtime covered bumpable block evidence');
    } else {
      failures.push(
        'platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。',
      );
    }

    // ----- ability acquisition -----
    const beforeAbilities = snapshotAbilities(beforeSnap);
    const afterAbilities = snapshotAbilities(afterSnap);
    const abilityEvidence = hasEvidence([
      /gain[_ -]?ability/,
      /ability[_ -]?gain/,
      /abilities?\.?double[_ -]?jump/,
      /double[_ -]?jump/,
      /dash/,
      /shield/,
      /magnet/,
      /ground[_ -]?pound/,
      /wall[_ -]?jump/,
    ]);
    const abilityChanged =
      JSON.stringify(beforeAbilities) !== JSON.stringify(afterAbilities) || abilityEvidence;
    if (abilityChanged && abilityEvidence) {
      checks.push('platformer gameplay runtime covered ability acquisition evidence');
    } else {
      failures.push(
        'platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。',
      );
    }

    // ----- ability-gated route -----
    const gateEvidence = hasEvidence([
      /unlock[_ -]?gate/,
      /gate[_ -]?unlock/,
      /gates?\./,
      /route[_ -]?reachable/,
      /reachable[_ -]?route/,
      /reachable[_ -]?target/,
      /routes?unlocked/,
      /routeReachableAfterAbility/i,
    ]);
    const gateDelta =
      findNumericValue(afterSnap, [/gatesunlocked/i, /routesunlocked/i, /reachabletargets/i]) >
        findNumericValue(beforeSnap, [
          /gatesunlocked/i,
          /routesunlocked/i,
          /reachabletargets/i,
        ]) ||
      countOpenGates(afterSnap) > countOpenGates(beforeSnap) ||
      gateEvidence;
    if (abilityChanged && abilityEvidence && gateDelta && gateEvidence) {
      checks.push('platformer gameplay runtime covered ability-gated route evidence');
    } else {
      failures.push(
        'platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。',
      );
    }

    // ----- comboChallenge coverage -----
    const comboRequires = textFrom(
      (gameplayMechanics as Record<string, unknown>).comboChallenge,
    );
    const comboText = evidence;
    const comboHasJump = /jump/.test(comboText);
    const comboAxisCount = [
      /stomp|enemy/,
      /block|bump|question/,
      /ability|abilities|double[_ -]?jump|doublejump|dash|shield|magnet|ground[_ -]?pound|groundpound|wall[_ -]?jump|walljump/,
      /gate|route|unlock|reachable/,
    ].filter((pattern) => pattern.test(comboText)).length;
    const comboCovered =
      /combo|challenge|sequence/.test(comboText) &&
      comboHasJump &&
      comboAxisCount >= 2 &&
      /requires|target/.test(comboRequires);
    if (comboCovered) {
      checks.push('platformer gameplay runtime covered comboChallenge evidence');
    } else {
      failures.push(
        'platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。',
      );
    }

    return { passed: failures.length === 0, failures, checks };
  }

  /**
   * 通用 failureCode 翻译成 platformer 视角的修复指导。
   * 找不到就返回 undefined，调用方走通用层的 generic instruction。
   */
  repairGuidance(failureCode: string): string | undefined {
    const entry = lookupPlatformerRepair(failureCode);
    return entry?.repairInstruction;
  }
}

// ---------------------------------------------------------------------------
// 暴露实例 + 自注册（side-effect import）
// ---------------------------------------------------------------------------

/** 单例 — 给主入口直接调用 */
export const platformerChecker = new PlatformerChecker();

// 自注册到 registry — `gameArtifactValidator.ts` 通过 side-effect import 触发
gameSubtypeRegistry.register(platformerChecker);

// 把仓库内部用到的 helper / 类型转发给上层 — repair spec 集成时需要 classify / code-set
export { classifyPlatformerFailure, PLATFORMER_REPAIR_CODES, PLATFORMER_REPAIR_CODE_SET };
export type { PlatformerRepairCode };
