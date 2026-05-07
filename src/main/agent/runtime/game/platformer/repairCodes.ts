/**
 * Platformer-specific 失败码与匹配规则。
 *
 * 任务 C 之前这些 code 散落在 `artifactRepairSpec.ts` 的巨型 if/else 链里，
 * 现在抽到 PlatformerChecker 持有的一份专属表里。非 platformer 的通用结构错误
 * （lost_interactive_contract 等 7 个）继续留在 `artifactRepairSpec.ts`，
 * 那是跨 subtype 共享的通用层。
 *
 * 数据来源 = `artifactRepairSpec.ts` 的 classifyFailure / messageForCode / buildRepairHints
 * 三个函数原始内容；这里**保持文案 byte-for-byte 一致**，零行为变化。
 */
import type { ArtifactRepairIssueSeverity } from '../../artifactRepairSpec';

/** Platformer subtype 持有的失败码 */
export type PlatformerRepairCode =
  | 'missing_gameplay_mechanics'
  | 'gameplay_mechanics_without_runtime_evidence'
  | 'ability_gate_without_reachability';

export interface PlatformerRepairEntry {
  /** 唯一失败码 */
  code: PlatformerRepairCode;
  /** 用来识别 platformer-specific failure message 的正则；命中即归到这个 code */
  pattern: RegExp;
  /** 严重度 — platformer 的失败都是 error 级 */
  severity: ArtifactRepairIssueSeverity;
  /** message：在 issue 列表里露出的简短描述 */
  message: string;
  /** repairInstruction：给 LLM 的具体修复说明（issue.repairInstruction） */
  repairInstruction: string;
  /**
   * 进一步的 repair hints — 只在 buildRepairHints 阶段附加。
   * 多条 hint 之间是补充关系，不是替代。
   */
  hints: readonly string[];
}

export const PLATFORMER_REPAIR_CODES: readonly PlatformerRepairEntry[] = [
  {
    code: 'missing_gameplay_mechanics',
    pattern:
      /platformer[\s\S]{0,120}缺少 gameplayMechanics|gameplayMechanics[\s\S]{0,120}缺少 (?:enemies|blocks|abilities|gates|comboChallenge|stompable enemy|bumpable\/question block)|comboChallenge 必须组合/i,
    severity: 'error',
    message: 'Platformer gameplay mechanics contract is missing or incomplete.',
    repairInstruction:
      'Add platformer gameplayMechanics to __GAME_META__ with enemies, blocks, abilities, gates, and comboChallenge, then implement those objects in live collision/update logic instead of only declaring them.',
    hints: [
      'Platformer metadata template: __GAME_META__.gameplayMechanics = { enemies: [{ id: "goomba-1", stompable: true, defeatReward: "bounceCoin" }], blocks: [{ id: "q1", type: "question", bumpableFromBelow: true, reward: "doubleJump", usedState: "empty" }], abilities: [{ id: "doubleJump", type: "doubleJump", acquiredFrom: "q1", effect: "second air jump", unlocksRoute: "upper-route" }], gates: [{ id: "upper-gap", requiresAbility: "doubleJump", blocksAccessTo: "upper-route" }], comboChallenge: [{ id: "combo", requires: ["jump", "stomp", "bumpBlock", "doubleJump"], target: "upper-route" }] }; every field is an array even with one item, never an object map.',
      'Implement collision code: stomp marks enemy defeated and bounces player.vy; bump marks block used and spawns the ability; ability changes movement; gate checks ability before route access.',
    ],
  },
  {
    code: 'ability_gate_without_reachability',
    pattern:
      /gate 必须在获得技能后改变|requiresAbility|blocksAccessTo|技能.*(?:路线|可达|route)|ability 必须通过真实输入获得|Gate remained locked|gate remained locked/i,
    severity: 'error',
    message: 'Platformer ability does not prove gated route reachability.',
    repairInstruction:
      'Make one ability change movement or interaction rules and unlock a real gated route. snapshot() should expose abilities and gate/route state, and runSmokeTest() must prove ability false->true followed by gate/route unreachable->reachable.',
    hints: [
      'Platformer runSmokeTest template: snapshot before, step() to stomp an enemy and assert enemiesDefeated plus player.vy/bounce; step() to bump a question block and assert blocksUsed/spawnedReward; step() to collect ability and assert abilities.doubleJump false->true; then assert routeReachable or gates.upperRoute changes after ability.',
      'Coverage must name the proven mechanics only after assertions pass, for example coverage.mechanics = ["stompEnemy", "bumpBlock", "gainAbility", "unlockGate", "comboChallenge"]; coverage.rewards = ["defeatReward", "blockAbility"]; coverage.stateChanges = ["enemiesDefeated", "player.vy", "blocksUsed", "spawnedReward", "abilities.doubleJump", "gates.upperRoute", "routeReachableAfterAbility"].',
      'If the smoke path says Failed to bump/stomp or gate remained locked, move the block/enemy/gate into the deterministic smoke path or add a helper path inside real physics controls; do not mark coverage true until snapshot proves the state changed.',
    ],
  },
  {
    code: 'gameplay_mechanics_without_runtime_evidence',
    pattern:
      /gameplayMechanics 缺少 runtime 证据|stompable enemy 必须通过 step\/runSmokeTest|bumpable\/question block 必须通过 step\/runSmokeTest|comboChallenge coverage 必须证明|Failed to bump block|Failed to stomp enemy|bump block or gain ability/i,
    severity: 'error',
    message: 'Platformer gameplay mechanics are declared without runtime evidence.',
    repairInstruction:
      'Repair runSmokeTest() so it drives step() through stomp enemy, bump block, gain ability, unlock gate/route, and combo challenge, recording coverage only after before/after snapshot changes prove each mechanic.',
    hints: [
      'Platformer runSmokeTest template: snapshot before, step() to stomp an enemy and assert enemiesDefeated plus player.vy/bounce; step() to bump a question block and assert blocksUsed/spawnedReward; step() to collect ability and assert abilities.doubleJump false->true; then assert routeReachable or gates.upperRoute changes after ability.',
      'Coverage must name the proven mechanics only after assertions pass, for example coverage.mechanics = ["stompEnemy", "bumpBlock", "gainAbility", "unlockGate", "comboChallenge"]; coverage.rewards = ["defeatReward", "blockAbility"]; coverage.stateChanges = ["enemiesDefeated", "player.vy", "blocksUsed", "spawnedReward", "abilities.doubleJump", "gates.upperRoute", "routeReachableAfterAbility"].',
      'If the smoke path says Failed to bump/stomp or gate remained locked, move the block/enemy/gate into the deterministic smoke path or add a helper path inside real physics controls; do not mark coverage true until snapshot proves the state changed.',
    ],
  },
];

/** O(1) 查表 — code → entry */
const ENTRY_BY_CODE: ReadonlyMap<PlatformerRepairCode, PlatformerRepairEntry> = new Map(
  PLATFORMER_REPAIR_CODES.map((entry) => [entry.code, entry]),
);

/** 给定 code，查 entry。找不到返回 undefined（generic 走通用层处理） */
export function lookupPlatformerRepair(code: string): PlatformerRepairEntry | undefined {
  return ENTRY_BY_CODE.get(code as PlatformerRepairCode);
}

/**
 * 给定 platformer-specific failure 文本，匹配第一个命中的条目。
 * 找不到时由调用方 fallback 到通用 classifyFailure。
 */
export function classifyPlatformerFailure(text: string): PlatformerRepairEntry | undefined {
  for (const entry of PLATFORMER_REPAIR_CODES) {
    if (entry.pattern.test(text)) return entry;
  }
  return undefined;
}

/** 平台游戏所有 code 的字面量集合 — 调用方判断 issue.code 是否属于 platformer */
export const PLATFORMER_REPAIR_CODE_SET: ReadonlySet<PlatformerRepairCode> = new Set(
  PLATFORMER_REPAIR_CODES.map((entry) => entry.code),
);
