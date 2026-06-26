/**
 * Dashboard artifact verification — public interfaces.
 *
 * 镜像 src/main/agent/runtime/deck/types.ts 的两层 dispatch 结构（顶层
 * verifier + subtype checker + probe declaration），但跟 deck 三处不同：
 *
 * 1. validate 是 async — dashboard 验证要真起 browser 跑 Playwright probe。
 * 2. input 是 filePath（落盘的 HTML），不是 in-memory structured data。
 *    Replit Verifier 在 REPL 跑 Playwright + DOM + ARIA 防 Potemkin，dashboard
 *    走同样的 file-on-disk → browser launch 路径（详见 plan §3 决策 2）。
 * 3. probe 词汇表跟 deck 完全不同 — declarative scope 是"整个 HTML 文件内容"
 *    （regex / DOM presence），不是 slide-level scope。**不复用 deck 的
 *    SlideScope / SlidePredicate**。
 *
 * 跨 kind 顶层接口仍按 ADR 016 不抽象（详见
 * 内部文档）。
 *
 * PR-B 的 scope：定类型 + 骨架 + 占位空 probes 集合。具体 probe（declarative
 * html_complete / no_lorem_ipsum / consistent_styling，imperative loads_no_error
 * / state_change_on_click 等）在 PR-C/D/E 加。
 */

import type { BrowserVisualSmokeSummary } from '../browser/types';

// ---------------------------------------------------------------------------
// Verifier I/O
// ---------------------------------------------------------------------------

/**
 * Dashboard artifact 的 input。
 *
 * filePath 必填 — Playwright launch 必须有 file URL。caller 负责把生成的
 * HTML 落盘后再调 verifier。
 */
export interface DashboardArtifactInput {
  /** Dashboard HTML 文件的绝对路径 */
  filePath: string;
  /** 任务 brief 解析出来的 metadata（产品/受众/风格等），probe 暂不消费 */
  metadata?: Record<string, unknown>;
}

/** 单条 probe 的判定结果 */
export interface DashboardProbeResult {
  /** Probe id，对应 DashboardProbeDeclaration.id */
  probe: string;
  passed: boolean;
  /** 失败 reason — 给 LLM repair / log 用，pass 时为 undefined */
  failure?: string;
  /** 可选 diagnostics — imperative probe 的浮窗信息（console errors / DOM hash 等） */
  diagnostics?: Record<string, unknown>;
}

/** Subtype checker 的整体 verification result */
export interface DashboardCheckResult {
  passed: boolean;
  probes: readonly DashboardProbeResult[];
  /** failures 是 probes 里 passed=false 那部分的 failure 字符串收敛 */
  failures: readonly string[];
  /** 触发该结果的 subtype id（来自 checker.subtype） */
  subtype: string;
  /**
   * Imperative probe 跑过 browser visual smoke 时的原始结果 — 调试 / repair
   * prompt 用。复用 game validator 抽出来的 BrowserVisualSmokeSummary 形态
   * 让两边可以共享 diagnostics 解析逻辑。
   */
  browserVisualSmoke?: BrowserVisualSmokeSummary;
}

// ---------------------------------------------------------------------------
// Layer B: Subtype checker — registry 接入点
// ---------------------------------------------------------------------------

/**
 * 一个 dashboard subtype 的 checker — 每个 subtype 实现一个，通过 registry 注册。
 *
 * PR-B 只占位 'general'。未来 subtype 候选：'data-viz' / 'form-app' /
 * 'admin-panel' 等，按 plan §8 不在本计划范围。
 */
export interface DashboardSubtypeChecker {
  /** Subtype identifier — e.g. 'general' */
  readonly subtype: string;
  /** 这个 subtype 声明的 probe 列表 */
  readonly probes: readonly DashboardProbeDeclaration[];
  /** 跑全部 probe 并 aggregate 成 DashboardCheckResult */
  validate(input: DashboardArtifactInput): Promise<DashboardCheckResult>;
}

// ---------------------------------------------------------------------------
// Layer C: Probe declaration
// ---------------------------------------------------------------------------

/**
 * 一个 probe 的声明 — 两个 mode 的 discriminated union（仿 deck）。
 *
 * declarative: predicate 在 HTML 文本 / DOM 上做的简单判定
 *              （PR-C 加 html_complete / no_lorem_ipsum / consistent_styling）
 * imperative:  evaluate 自带函数，自由跑 Playwright launch / interaction
 *              （PR-D 加 loads_no_error / viewport_non_blank；
 *               PR-E 加 anti-Potemkin state_change_on_click）
 */
export type DashboardProbeDeclaration = DashboardDeclarativeProbe | DashboardImperativeProbe;

/** 声明式 probe — predicate 评估 HTML 文本 / 浅层 DOM */
export interface DashboardDeclarativeProbe {
  id: string;
  kind: 'declarative';
  /** 给 reader / debug 看的描述（不影响判定） */
  description: string;
  predicate: DashboardPredicate;
  /**
   * 'expect-true' = predicate 结果必须为 true 才 pass
   * 'expect-false' = predicate 结果必须为 false 才 pass（如 no_lorem_ipsum）
   */
  expectation: 'expect-true' | 'expect-false';
  /** 失败时对外的描述（中文，给 LLM repair 看） */
  failureMessage: string;
}

/** 命令式 probe — Playwright-driven 或其他自由逻辑 */
export interface DashboardImperativeProbe {
  id: string;
  kind: 'imperative';
  /** 给 reader / debug 看的描述（不影响判定） */
  description: string;
  /** evaluate 自带 file 加载 + browser 跑 + 结果聚合 */
  evaluate(input: DashboardArtifactInput): Promise<DashboardProbeResult>;
}

/**
 * Predicate — 故意做窄。只覆盖 PR-C 实际需要的 op。
 *
 * 后续 PR 真要扩（如 dom-element-exists / aria-role-present）再加；不要预先
 * 抽象未来不一定用得上的 op。
 */
export type DashboardPredicate =
  /** 总是 true — 调试 / 占位用 */
  | { op: 'truthy' }
  /** HTML 文本（原始字符串）用 regex 匹配；pattern 是字符串，运行时 new RegExp */
  | { op: 'html-content-matches'; pattern: string; flags?: string }
  /** HTML 文本不能匹配（用于 no_lorem_ipsum 等"不应出现"类规则）*/
  | { op: 'html-content-not-matches'; pattern: string; flags?: string };
