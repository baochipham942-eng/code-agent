/**
 * Deck artifact verification — public interfaces.
 *
 * 镜像 src/main/agent/runtime/game/types.ts 的两层 dispatch 结构，但 deck
 * 的 verb 词汇表跟 game 完全不同（game 是 runtime 动作，deck 是 structural
 * 性质），因此**不复用 game 的 VerbId / VerbDeclaration / PredicateExpr**。
 *
 *   顶层 verifier            — DeckVerifier（独立类，不与 game 共享接口；
 *                              详见 docs/decisions/016-no-cross-kind-verifier-interface.md）
 *
 *   subtype checker          — DeckSubtypeChecker，每个 deck 子流派
 *                              (general / executive-deck / academic-paper / ...)
 *                              通过 registry 注册自己。PR-2 只占位 'general'。
 *
 *   probe declaration        — DeckProbeDeclaration，两个 mode：
 *     declarative: scope + predicate，覆盖简单匹配（intro / evidence / summary）
 *     imperative:  逃逸 hatch，复杂规则（连续 N 张 numeric-heavy slide）走 TS 函数
 *
 * 务实承认抽象边界：narrativeValidator 的 consecutive_data 用 declarative 表达
 * 需要 windowing + quantifier，强行声明式化得不偿失。
 */

import type { SlideData } from '../../../tools/media/ppt/types';
import type { StructuredSlide } from '../../../tools/media/ppt/slideSchemas';

// ---------------------------------------------------------------------------
// Verifier I/O
// ---------------------------------------------------------------------------

/**
 * Deck artifact 的 input — 同时持 structured + legacy 两种形态：
 * - structured: 给 schema validation 用（slideSchemas.validateStructuredSlides）
 * - legacy:     给 narrative probe 用（兼容 narrativeValidator 现有 8 个测试 case）
 *
 * PR-3 接 pptGenerate.ts 时再决定真实生成路径喂哪种形态；PR-2 接口宽松、
 * 两种都拿。
 */
export interface DeckArtifactInput {
  structured: readonly StructuredSlide[];
  legacy: readonly SlideData[];
  /** 任务 brief 解析出来的 metadata（topic / 受众 / 风格等），probe 暂不消费 */
  metadata?: Record<string, unknown>;
}

/** 单条 probe 的判定结果 */
export interface DeckProbeResult {
  /** Probe id，对应 DeckProbeDeclaration.id */
  probe: string;
  passed: boolean;
  /** 失败 reason — 给 LLM repair / log 用，pass 时为 undefined */
  failure?: string;
  /** 如果失败定位到具体 slide，记下 index — 调试用 */
  affectedSlideIndex?: number;
}

/** Subtype checker 的整体 verification result */
export interface DeckCheckResult {
  passed: boolean;
  probes: readonly DeckProbeResult[];
  /** failures 是 probes 里 passed=false 那部分的 failure 字符串收敛 */
  failures: readonly string[];
  /** 触发该结果的 subtype id（来自 checker.subtype） */
  subtype: string;
}

// ---------------------------------------------------------------------------
// Layer B: Subtype checker — registry 接入点
// ---------------------------------------------------------------------------

/**
 * 一个 deck subtype 的 checker — 每个 subtype 实现一个，通过 registry 注册。
 *
 * 设计原则：
 * - probes 是声明式集合，validate 是 dispatch + aggregate
 * - 同一 checker 内的 probes 顺序无关，相互独立
 * - subtype 自己决定 probe 列表（general 用 narrative 4 条；executive-deck
 *   未来可能加 stakeholder ask / one-page rule 等）
 */
export interface DeckSubtypeChecker {
  /** Subtype identifier — e.g. 'general' / 'executive-deck' / 'academic-paper' */
  readonly subtype: string;
  /** 这个 subtype 声明的 probe 列表 */
  readonly probes: readonly DeckProbeDeclaration[];
  /** 跑全部 probe 并 aggregate 成 DeckCheckResult */
  validate(deck: DeckArtifactInput): DeckCheckResult;
}

// ---------------------------------------------------------------------------
// Layer C: Probe declaration
// ---------------------------------------------------------------------------

/**
 * 一个 probe 的声明 — 两个 mode 的 discriminated union。
 *
 * declarative: scope（在哪些 slide 上判）+ predicate（每张 slide 的判定）
 *              覆盖 80% 的 narrative 规则（intro / evidence / summary）
 *
 * imperative:  evaluate 函数自己跑全部 deck，返回 ProbeResult
 *              留给复杂逻辑（windowing / quantifier / cross-slide aggregation）
 */
export type DeckProbeDeclaration = DeclarativeProbe | ImperativeProbe;

/** 声明式 probe — 简单 scope + predicate 即可表达 */
export interface DeclarativeProbe {
  id: string;
  kind: 'declarative';
  scope: SlideScope;
  predicate: SlidePredicate;
  /** 触发条件：'expect-true' = scope 范围内必须满足 predicate；'expect-some' = 至少一张满足 */
  expectation: 'expect-true' | 'expect-some';
  /** 失败时对外的描述（中文，给 LLM repair 看） */
  failureMessage: string;
}

/** 命令式 probe — 复杂规则用，自带 evaluate 函数 */
export interface ImperativeProbe {
  id: string;
  kind: 'imperative';
  /** 给 reader / debug 看的描述（不影响判定） */
  description: string;
  evaluate(deck: DeckArtifactInput): DeckProbeResult;
}

/**
 * Slide scope — 在 slides[] 上挑哪些 slide 评估 predicate。
 * 'first-content' / 'last-content' 解决 narrativeValidator 里"首页内容页"
 * "最后一个非 isEnd"这两种特殊定位。
 */
export type SlideScope =
  | { type: 'first-content' }   // 第一个 isTitle=false && isEnd=false
  | { type: 'last-content' }    // 最后一个 isEnd=false（含 isTitle）
  | { type: 'any' }             // 任一 slide 满足即可（exists）
  | { type: 'all' };            // 全部 slide 必须满足（forall）

/**
 * Slide-level predicate — 在单张 slide 上做的判定。
 *
 * 故意做窄：只覆盖 narrative 4 条规则需要的算子。PR-3 若需要 deck-wide
 * aggregation（如"全 deck 字数 < 阈值"）再扩 SlidePredicate 或加新 op。
 * 不要预先抽象未来不一定用得上的 op。
 */
export type SlidePredicate =
  /** slide.title 用 regex 匹配（pattern 是字符串，运行时 new RegExp） */
  | { op: 'title-matches'; pattern: string; flags?: string }
  /** slide.title 或任一 slide.points 用 regex 匹配 */
  | { op: 'title-or-points-matches'; pattern: string; flags?: string }
  /** 总是 true — 调试 / 占位用 */
  | { op: 'truthy' };
