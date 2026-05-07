/**
 * Game acceptance — public interfaces.
 *
 * 两层 dispatch 架构：
 *
 *   Layer B: GameSubtypeChecker        — 每个游戏 subtype（platformer / runner / tower-defense）
 *                                        通过 GameSubtypeRegistry 注册自己
 *
 *   Layer C: VerbDeclaration           — declarative probes（§4.4 verb taxonomy），
 *                                        validator runtime 读取并驱动
 *
 * 顶层 dispatch（"Layer A: ArtifactKindVerifier"）的接口曾经声明在此文件，
 * 但从未有任何类 implements。生产路径走的是 validateGameArtifact 自由函数
 * （src/main/agent/runtime/gameArtifactValidator.ts），deck 那边自己一套
 * DeckVerifier 类。两边形态分歧到无法共用同一接口。详见
 * docs/decisions/016-no-cross-kind-verifier-interface.md。
 */

import type { ARTIFACT_KINDS, VERB_CLASSES } from '@shared/constants';

// ---------------------------------------------------------------------------
// Artifact kinds
// ---------------------------------------------------------------------------

/** ArtifactKind — 顶层 artifact 类型枚举（被 skill-loader 等消费） */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// ---------------------------------------------------------------------------
// Layer B: Subtype checker — plug-in point
// ---------------------------------------------------------------------------

/**
 * 游戏 subtype 的接入点 — 每个 subtype 实现一个 checker 注册到 registry。
 *
 * 设计原则:
 * - declaredVerbs 是声明式的（VerbDeclaration[]），不嵌业务代码
 * - validateMechanics 看 HTML/JS snippet 静态结构（L1）
 * - validateRuntimeEvidence 看 before/after snapshot + smoke 结果（L2 / L3）
 * - repairGuidance 把通用 failure code 转译成 subtype-specific 修复指导
 */
export interface GameSubtypeChecker {
  /** Subtype identifier — e.g. 'platformer' / 'runner' / 'tower-defense' */
  readonly subtype: string;
  /** 这个 subtype 声明支持的 verbs（每个 verb 三件套：selector / success / liveness） */
  readonly declaredVerbs: readonly VerbDeclaration[];

  /**
   * Layer L1 — 静态：检查 artifact snippet 是否实现了声明的 mechanics。
   * snippet 通常是 HTML 或抽出来的 inline script。
   */
  validateMechanics(snippet: string, ctx: SubtypeContext): MechanicsResult;

  /**
   * Layer L2 / L3 — 运行时：拿 before/after snapshot + smoke 结果，
   * 用 declaredVerbs 驱动 predicate 验证（每个 verb 是否真的能触发状态变化）。
   */
  validateRuntimeEvidence(
    beforeSnap: Snapshot,
    afterSnap: Snapshot,
    smoke: SmokeResult,
    ctx: SubtypeContext,
  ): RuntimeEvidenceResult;

  /**
   * Subtype-specific 修复指导 — 输入通用 failureCode（如 'verb_no_evidence'），
   * 返回 subtype 视角的具体改法（"在 step('jump') 后断言 player.y 减小"）。
   */
  repairGuidance(failureCode: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Verb taxonomy (Layer C — declarative probes)
// ---------------------------------------------------------------------------

/** 6-class verb taxonomy — 与 docs §4.4 表对应 */
export type VerbClass = (typeof VERB_CLASSES)[number];

/**
 * 通用 verb id — 跨流派的最小动词集。
 * 与 docs/audits/2026-05-07-game-acceptance-architecture.md §4.4 完全对齐。
 *
 * 单一 subtype 的特化（如 platformer 的 'stomp'）不是新 VerbId，
 * 而是 'defeat' 的 VerbDeclaration 加上特定 successPredicate。
 */
export type VerbId =
  // movement
  | 'moveTo'
  | 'traverse'
  // acquisition
  | 'collect'
  | 'unlock'
  // conflict
  | 'defeat'
  | 'defend'
  | 'evade'
  // construction
  | 'build'
  | 'upgrade'
  // cognition
  | 'solve'
  | 'navigate'
  // progression
  | 'complete'
  | 'fail';

/**
 * 一个 verb 的声明 — subtype 通过这玩意告诉 validator
 * "我支持的动作是 X、它在 snapshot 里长 Y 这样、Z 算成功"。
 */
export interface VerbDeclaration {
  /** 通用动词 id */
  verb: VerbId;
  /**
   * 在 snapshot 里怎么找到主语 — dotted path / array index path。
   * 例：'enemiesDefeated', 'player.abilities.doubleJump', 'enemies[0].dead'.
   */
  selector: string;
  /** 成功条件（after snapshot 必须满足的断言） */
  successPredicate: PredicateExpr;
  /** 可选 liveness — 从 start state ≤N 步可达；不写就只查 success */
  livenessPredicate?: PredicateExpr;
  /** false 表示是 "如果实现了就检查"，不强制 */
  required: boolean;
}

/**
 * Declarative predicate 语言 — 用 JSON-like 结构描述断言，避免在配置里写 JS。
 *
 * 设计选择：op 字段来区分。string `path` 走 extractByPath（dotted + array index）。
 * 嵌套用 'and' / 'or'，足够表达常见验证条件，又能序列化进 SKILL.md frontmatter。
 *
 * 实现见 verbs.ts 的 evaluatePredicate。
 */
export type PredicateExpr =
  /** path 上的值严格等于 value（适合 boolean / 字符串 / 数字常量） */
  | { op: 'eq'; path: string; value: unknown }
  /** before→after 数值上升（适合 score / kill count） */
  | { op: 'increase'; path: string }
  /** before→after 数值下降（适合 hp / lives） */
  | { op: 'decrease'; path: string }
  /** before→after 任意变化（适合 player.x / player.y 之类） */
  | { op: 'change'; path: string }
  /** path 上的值 truthy */
  | { op: 'truthy'; path: string }
  /** path 上的值 falsy */
  | { op: 'falsy'; path: string }
  /** 字符串值 regex 匹配 */
  | { op: 'matches'; path: string; pattern: string }
  /** 全部 clause 通过 */
  | { op: 'and'; clauses: PredicateExpr[] }
  /** 任一 clause 通过 */
  | { op: 'or'; clauses: PredicateExpr[] };

// ---------------------------------------------------------------------------
// Snapshot / runtime evidence shapes
// ---------------------------------------------------------------------------

/**
 * 游戏运行时 snapshot — 由 artifact 自身的 snapshot() 函数返回，
 * 通用契约：plain object，可序列化，validator 用 dotted path 提取字段。
 *
 * 不约束 schema — 不同 subtype 的 snapshot 字段不一样，
 * SubtypeChecker 自己在 declaredVerbs.selector 里指认要哪些字段。
 */
export type Snapshot = Record<string, unknown>;

/** runSmokeTest 的执行结果（runtime smoke / browser visual smoke） */
export interface SmokeResult {
  attempted: boolean;
  passed: boolean;
  failures: readonly string[];
  checks: readonly string[];
  /** 可选：subtype 自定义的额外诊断（截图、console 错误等） */
  diagnostics?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Subtype checker I/O
// ---------------------------------------------------------------------------

/**
 * Subtype checker 的执行上下文 — artifact 标识 + 严格模式 + 自由 metadata。
 */
export interface SubtypeContext {
  /** 用于错误提示的 artifact 标识（filePath 或 hash） */
  artifactRef: string;
  /** 是否要严格检查 declaredVerbs 的 required 字段 */
  strict: boolean;
  /** subtype-level 元信息 — SubtypeChecker 自己塞 */
  metadata?: Record<string, unknown>;
}

/**
 * Layer L1 静态结果 — subtype 检查 snippet 中的 mechanics 实现。
 */
export interface MechanicsResult {
  passed: boolean;
  failures: readonly string[];
  checks: readonly string[];
  /** 命中的 verb 列表 — 调试用 */
  matchedVerbs?: readonly VerbId[];
}

/**
 * Layer L2 / L3 运行时结果 — verb-by-verb 的 evidence。
 */
export interface RuntimeEvidenceResult {
  passed: boolean;
  failures: readonly string[];
  checks: readonly string[];
  /** 每个 verb 的执行证据 */
  verbEvidence?: readonly VerbEvidence[];
}

/** 单个 verb 的运行时证据 */
export interface VerbEvidence {
  verb: VerbId;
  selector: string;
  passed: boolean;
  /** 失败时给 LLM 看的 reason — predicate evaluator 生成 */
  reason: string;
}
