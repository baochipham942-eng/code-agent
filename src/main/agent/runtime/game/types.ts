/**
 * Game acceptance — public interfaces.
 *
 * 三层 dispatch 架构（详见 docs/audits/2026-05-07-game-acceptance-architecture.md §5.1）:
 *
 *   Layer A: ArtifactKindVerifier      — TS hard dispatch by artifact kind
 *     ├── GameVerifier (kind='game')   — 进 Layer B 的入口
 *     ├── DeckVerifier (kind='slide-deck')
 *     └── ...
 *
 *   Layer B: GameSubtypeChecker        — 每个游戏 subtype（platformer / runner / tower-defense）
 *                                        通过 GameSubtypeRegistry 注册自己
 *
 *   Layer C: VerbDeclaration           — declarative probes（§4.4 verb taxonomy），
 *                                        validator runtime 读取并驱动
 *
 * 本文件**只**定义类型契约，不带任何实现。Phase 2 platformer 迁移在 task C。
 */

import type { ARTIFACT_KINDS, VERB_CLASSES } from '@shared/constants';

// ---------------------------------------------------------------------------
// Artifact kinds & top-level dispatcher
// ---------------------------------------------------------------------------

/** Layer A 维度 — 顶层 artifact kind，配合 hard dispatch 使用 */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Layer A 的 dispatch 节点 — 每个 ArtifactKind 提供一个 verifier。
 *
 * 实现责任：
 * - canHandle: 看 artifact 的元信息（hint / extension / inferred kind），决定是否归我
 * - validate: 跑三层验证（L1 静态 / L2 运行时 / L3 行为），返回结构化结果
 */
export interface ArtifactKindVerifier {
  readonly kind: ArtifactKind;
  canHandle(artifact: ArtifactInput): boolean;
  validate(artifact: ArtifactInput, ctx: VerifyContext): Promise<VerifyResult>;
}

/**
 * Game 特化 — 在 ArtifactKindVerifier 之上挂 subtype dispatcher。
 *
 * 实现责任：
 * - getSubtypeChecker: 从 registry 查 subtype（'platformer' / 'runner' / ...）
 * - 调用方在 validate 内部按 subtype 调对应 GameSubtypeChecker
 */
export interface GameVerifier extends ArtifactKindVerifier {
  readonly kind: 'game';
  getSubtypeChecker(subtype: string): GameSubtypeChecker | undefined;
}

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
// Verifier I/O
// ---------------------------------------------------------------------------

/**
 * Validator 入口拿到的 artifact 描述 — 不强行限制成 file path，
 * 也允许内存里的字符串内容（生成阶段先验证再落盘）。
 */
export interface ArtifactInput {
  /** 推断或显式声明的 kind（来自触发器） */
  kind: ArtifactKind;
  /** game 特化字段 — subtype hint，可选 */
  subtype?: string;
  /** 文件路径（落盘后） */
  filePath?: string;
  /** 原始内容（生成阶段优先用这个，避免反复读文件） */
  content?: string;
  /** 额外元信息（任务 brief 解析出来的 metadata） */
  metadata?: Record<string, unknown>;
}

/**
 * Validator 上下文 — 跨层共享的执行环境：临时目录、超时、验证开关。
 */
export interface VerifyContext {
  /** 临时工作目录（验证产物放这里） */
  workspaceDir: string;
  /** 整体超时（ms） */
  timeoutMs: number;
  /** L2 运行时 smoke 开关 */
  runRuntimeSmoke: boolean;
  /** L3 浏览器 smoke 开关 */
  runBrowserSmoke: boolean;
  /** 当前 acceptance 轮次（用于 monotonicity gate） */
  attempt?: number;
}

/**
 * Subtype checker 的执行上下文 — 比 VerifyContext 多一些 subtype-aware 信息。
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
 * 顶层验证结果 — 三层结果折叠成一个，供 acceptance 流程做 best-of-N 排序用。
 */
export interface VerifyResult {
  /** 总体是否通过 */
  passed: boolean;
  /** 每层失败 reason 列表（L1+L2+L3 合并展示给 LLM repair） */
  failures: readonly string[];
  /** 通过的检查 — 用于 monotonicity gate 比对 */
  checks: readonly string[];
  /** 子 subtype 名（如有） */
  subtype?: string;
  /** L1 mechanics 结果（subtype checker 给的） */
  mechanics?: MechanicsResult;
  /** L2 / L3 runtime 结果 */
  runtime?: RuntimeEvidenceResult;
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
