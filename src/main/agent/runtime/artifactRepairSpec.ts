import type { GameArtifactValidationSummary } from './gameArtifactValidator';
import { REPAIR_PROMPT_LIMITS } from '../../../shared/constants/repair';
import { gameSubtypeRegistry } from './game/registry';
// side-effect import — PlatformerChecker 自注册并提供 platformer-specific repair codes
import './game/platformer/PlatformerChecker';
import {
  classifyPlatformerFailure,
  PLATFORMER_REPAIR_CODE_SET,
  PLATFORMER_REPAIR_CODES,
  type PlatformerRepairCode,
} from './game/platformer/repairCodes';

export type ArtifactRepairIssueSeverity = 'error' | 'warning';

/**
 * 通用（跨 subtype）的 issue code — Phase 2 task C 之后这里只剩 7 个生成/合约
 * 层面的结构错误。subtype-specific code（platformer 的 missing_gameplay_mechanics
 * 等）由各自 checker 持有，通过 union 合并到对外类型里。
 */
export type GenericArtifactRepairIssueCode =
  | 'lost_interactive_contract'
  | 'missing_contract_start'
  | 'missing_contract_snapshot'
  | 'missing_contract_smoke'
  | 'missing_test_contract'
  | 'malformed_test_contract'
  | 'missing_snapshot_metric'
  | 'non_executable_reachability_input'
  | 'control_no_state_change'
  | 'level_coverage_incomplete'
  | 'smoke_missing_coverage'
  | 'shortcut_state_mutation'
  | 'coverage_without_runtime_evidence'
  | 'input_normalizer_missing'
  | 'run_smoke_failed'
  | 'html_incomplete'
  | 'trailing_after_html'
  | 'canvas_not_responsive'
  | 'missing_user_input'
  | 'missing_controls_metadata'
  | 'missing_coverage_metadata'
  | 'missing_reachability_metadata'
  | 'missing_quality_metadata'
  | 'frontend_visual_smoke_failed'
  | 'generic_validation_failure';

export type ArtifactRepairIssueCode =
  | GenericArtifactRepairIssueCode
  | PlatformerRepairCode;

export interface ArtifactRepairIssue {
  code: ArtifactRepairIssueCode;
  severity: ArtifactRepairIssueSeverity;
  message: string;
  evidence: string[];
  repairInstruction: string;
}

export interface ArtifactRepairSpec {
  kind: 'game_artifact_repair';
  summary: string;
  issues: ArtifactRepairIssue[];
  mustFix: string[];
  allowedEditScope: string[];
  nextAction: string;
}

interface FailureClassification {
  code: ArtifactRepairIssueCode;
  repairInstruction: string;
}

const {
  MAX_EVIDENCE_LENGTH,
  MAX_PROMPT_ISSUES,
  MAX_PROMPT_CHARS,
} = REPAIR_PROMPT_LIMITS;

function compactText(value: string, maxLength: number = MAX_EVIDENCE_LENGTH): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

/**
 * 把 platformer-specific failure 文本扔给 PlatformerChecker（通过 repairCodes 表）。
 *
 * 任务 C 之前是直接写在 classifyFailure 的巨型 if-else 里；现在 subtype 知识在
 * 各 checker 自己的 repairCodes.ts 里。返回 undefined 表示 "我不认这条"，
 * 让 classifyFailure 继续往下匹配通用 code。
 *
 * 当前只接 platformer；后续 runner / tower-defense 加进来时，这里改成遍历 registry。
 */
function classifyFailureViaRegistry(text: string): FailureClassification | undefined {
  const platformerEntry = classifyPlatformerFailure(text);
  if (platformerEntry) {
    // 通过 registry.get('platformer') 拿 repair instruction —
    // 即使 PlatformerChecker.repairGuidance 被覆盖，这里也能拿到最新版本。
    const checker = gameSubtypeRegistry.get('platformer');
    const fromChecker = checker?.repairGuidance(platformerEntry.code);
    return {
      code: platformerEntry.code,
      repairInstruction: fromChecker ?? platformerEntry.repairInstruction,
    };
  }
  return undefined;
}

function classifyFailure(failure: string): FailureClassification {
  const text = compactText(failure, 1000);

  if (/no longer exposes the interactive artifact contract|失去.*交互.*合约|丢失.*交互.*合约/i.test(text)) {
    return {
      code: 'lost_interactive_contract',
      repairInstruction: 'Restore the generated artifact as a complete self-contained HTML file with its interactive metadata and window.__INTERACTIVE_TEST__ or window.__GAME_TEST__ contract.',
    };
  }
  if (/完整闭合|complete html|<\/html>\s*$|HTML 文件还没有完整/i.test(text)) {
    return {
      code: 'html_incomplete',
      repairInstruction: 'Return one complete HTML document with a final closing </html>; keep scripts and metadata before that closing tag.',
    };
  }
  if (/<\/html> 之后|after closing html|trailing/i.test(text)) {
    return {
      code: 'trailing_after_html',
      repairInstruction: 'Move all appended scripts, metadata, and JSON blocks inside the HTML document before </html>; leave no non-whitespace content after </html>.',
    };
  }
  if (/大型固定 canvas|固定 canvas|窄窗口.*裁切|responsive css|响应式 CSS|canvas.*(?:max-width|max-height|aspect-ratio|height:auto)/i.test(text)) {
    return {
      code: 'canvas_not_responsive',
      repairInstruction: 'Keep the canvas internal resolution if needed, but add responsive CSS on the canvas or wrapper, such as max-width: 100vw, max-height: 100vh, aspect-ratio, and height:auto, so narrow browser windows do not crop the game.',
    };
  }
  if (/browser visual smoke|frontend browser validation|runtime page errors|console errors|nonblank rendered content|visibly framed|visible DOM content/i.test(text)) {
    return {
      code: 'frontend_visual_smoke_failed',
      repairInstruction: 'Fix the rendered frontend, not only the metadata: load the HTML in a browser, resolve console/page errors, ensure canvas or DOM content is visible and nonblank, and keep the game contract attached to the same rendered state.',
    };
  }
  // subtype-specific failure 优先走 registry — platformer 的失败码（missing_gameplay_mechanics
  // 等）从 PlatformerChecker 拿，主入口不再持有 platformer 关键词。
  const subtypeMatch = classifyFailureViaRegistry(text);
  if (subtypeMatch) return subtypeMatch;
  if (
    /缺少通用交互测试合约|没有找到 runSmokeTest/i.test(text)
    || /(?:缺少|missing|不存在|not found|没有|未找到)[\s\S]{0,80}window\.__(?:INTERACTIVE|GAME)_TEST__/i.test(text)
    || /window\.__(?:INTERACTIVE|GAME)_TEST__[\s\S]{0,80}(?:缺少|missing|不存在|not found|没有|未找到)/i.test(text)
  ) {
    return {
      code: 'missing_test_contract',
      repairInstruction: 'Expose window.__INTERACTIVE_TEST__ or window.__GAME_TEST__ as a plain object with start(), snapshot(), and runSmokeTest().',
    };
  }
  if (/可平衡解析的对象字面量|游离的 start\/reset\/snapshot\/step\/runSmokeTest 方法尾巴|孤立的 contract tail|重复或孤立的 contract tail/i.test(text)) {
    return {
      code: 'malformed_test_contract',
      repairInstruction: 'Replace the full active window.__INTERACTIVE_TEST__ / window.__GAME_TEST__ object in one balanced edit, and remove any duplicate orphaned start/reset/snapshot/step/runSmokeTest tail after the contract closes.',
    };
  }
  if (/缺少 start\(\)|缺少 start 或 snapshot|缺少 start 和 snapshot/i.test(text)) {
    return {
      code: 'missing_contract_start',
      repairInstruction: 'Add a deterministic start() function to the test contract that resets the artifact to its real initial state.',
    };
  }
  if (/缺少 snapshot\(\)|缺少 snapshot probe/i.test(text)) {
    return {
      code: 'missing_contract_snapshot',
      repairInstruction: 'Add snapshot() to the test contract and include stable fields for actor state, progress, score/status, and any metric referenced by reachability steps.',
    };
  }
  if (/缺少 runSmokeTest\(\)|runSmokeTest 没有返回结构化结果|运行时没有找到 runSmokeTest/i.test(text)) {
    return {
      code: 'missing_contract_smoke',
      repairInstruction: 'Add runSmokeTest() that drives declared controls and returns { passed, checks, failures, coverage }.',
    };
  }
  if (/metric ".*" 不在 snapshot\(\) 结果里|snapshot\(\) 结果|metric .* 不在 snapshot/i.test(text)) {
    return {
      code: 'missing_snapshot_metric',
      repairInstruction: 'Make each reachability metric point to a real snapshot() field, or add that stable field to snapshot() and update it during live play. Do not use generic progress unless snapshot().progress exists and actually changes.',
    };
  }
  if (/缺少可执行输入|真实可派发的键值|可执行输入/i.test(text)) {
    return {
      code: 'non_executable_reachability_input',
      repairInstruction: 'Rewrite reachability inputs using dispatchable controls from metadata, such as ArrowRight, Space, or an array of those keys. Do not use prose labels, none, or abstract actions as input.',
    };
  }
  if (/snapshot 没有变化|无法证明主对象可操作|没有让 .* 满足/i.test(text)) {
    return {
      code: 'control_no_state_change',
      repairInstruction: 'Wire declared controls to real state changes and make reachability metrics change after those inputs are dispatched. If a score/progress metric does not change in that short input window, use player.x/player.vy or move the reward into the deterministic live collision path.',
    };
  }
  if (/authored levels|all authored levels|所有 authored levels|declared=\d+|scenarios 都可推进通关/i.test(text)) {
    return {
      code: 'level_coverage_incomplete',
      repairInstruction: 'Update gameplay and smoke coverage so every authored level, scenario, or segment can be advanced and reported as reachable.',
    };
  }
  if (/step\(\) 直接.*(?:奖励|收集物|能力|关卡|目标|胜利状态)|宽松距离|测试模式修改|直接推进关卡|掩盖路径不可达/i.test(text)) {
    return {
      code: 'shortcut_state_mutation',
      repairInstruction: 'Remove test-only shortcuts from step(); step() must advance the same input, physics, collision, reward, hazard, and progression rules that the playable game uses.',
    };
  }
  if (/input\.forEach is not a function|forEach is not a function|normalizeInput|step\(inputState, frames\?\).*string\[\]|step\(\) must accept string|string\[\].*object map|object map.*empty inputs/i.test(text)) {
    return {
      code: 'input_normalizer_missing',
      repairInstruction: 'Add a small normalizeInput(inputState) helper used by step() and runSmokeTest(). It must safely convert string input, string[] input, object map input, null, and empty input into one stable pressed-key map before any forEach/key checks.',
    };
  }
  if (/把对象存在|机制注册|覆盖声明当成通过证据|直接授予能力|直接修改.*(?:进度|分数|关卡|胜利|解锁)|不能证明玩家实际触发|不能证明玩家能用真实输入完成|真实流程里获得/i.test(text)) {
    return {
      code: 'coverage_without_runtime_evidence',
      repairInstruction: 'Change runSmokeTest() so every coverage.mechanics/rewards/risks/stateChanges entry is added only inside a branch that compares before/after snapshot values after step() dispatches real controls. Remove fallback branches that add coverage because enemies, spikes, doors, abilities, rewards, or items merely exist.',
    };
  }
  if (/缺少 coverage|coverage 没有覆盖|coverage 没有证明|coverage\.(?:mechanics|rewards|risks|stateChanges).*不能只返回数字|不能只返回数字、布尔值或 total 计数|无法证明玩法|奖励|风险|核心玩法/i.test(text)) {
    return {
      code: 'smoke_missing_coverage',
      repairInstruction: 'Return coverage from runSmokeTest() for mechanics, rewards, risks, stateChanges, and authored level reachability when declared.',
    };
  }
  if (/runSmokeTest 未通过|runSmokeTest 抛出异常|runSmokeTest 超过|无法运行交互 smoke|runSmokeTest\.(?:checks|failures) 必须是字符串数组/i.test(text)) {
    return {
      code: 'run_smoke_failed',
      repairInstruction: 'Fix runSmokeTest() so it completes without throwing or timing out, drives real controls, returns string-array checks and failures, and reports concrete failures only when behavior is still broken.',
    };
  }
  if (/缺少明确的用户输入入口|用户输入入口|玩家能实际操作/i.test(text)) {
    return {
      code: 'missing_user_input',
      repairInstruction: 'Add real keyboard, pointer, touch, or click input handlers that affect gameplay state.',
    };
  }
  if (/缺少 controls 元数据|controls 没有暴露|模拟什么输入/i.test(text)) {
    return {
      code: 'missing_controls_metadata',
      repairInstruction: 'Declare controls metadata with dispatchable input values that match the implemented input handlers.',
    };
  }
  if (/缺少可用于验收的关卡|缺少可用于验收的片段|缺少可用于验收的场景|缺少可用于验收的目标元数据/i.test(text)) {
    return {
      code: 'missing_coverage_metadata',
      repairInstruction: 'Declare authored levels, segments, scenarios, objectives, or missions so validation can compare promised scope with smoke coverage.',
    };
  }
  if (/缺少 reachability|缺少 progressPlan|缺少 acceptance|无法验证目标|progress.*不算|coverage.*不算|does not satisfy.*(?:progressPlan|reachability)/i.test(text)) {
    return {
      code: 'missing_reachability_metadata',
      repairInstruction: 'Declare a literal __GAME_META__.progressPlan or __GAME_META__.reachability array; do not rename it progress or coverage. Each step must contain executable inputs using real controls, frames, a snapshot metric path, an expected direction or target, and authored level/scenario coverage.',
    };
  }
  if (/缺少 qualityPlan|玩法承诺元数据|角色可辨识|奖励\/风险/i.test(text)) {
    return {
      code: 'missing_quality_metadata',
      repairInstruction: 'Declare qualityPlan or acceptance metadata for actor readability, core mechanics, rewards, risks, and authored-level coverage.',
    };
  }

  return {
    code: 'generic_validation_failure',
    repairInstruction: 'Repair the artifact behavior or metadata described by the evidence, then keep the validation contract deterministic and machine-readable.',
  };
}

/** 通用 issue code 列表 — 用于动态拼装 directCodePattern */
const GENERIC_ISSUE_CODES: readonly GenericArtifactRepairIssueCode[] = [
  'lost_interactive_contract',
  'missing_contract_start',
  'missing_contract_snapshot',
  'missing_contract_smoke',
  'missing_test_contract',
  'malformed_test_contract',
  'missing_snapshot_metric',
  'non_executable_reachability_input',
  'control_no_state_change',
  'level_coverage_incomplete',
  'smoke_missing_coverage',
  'shortcut_state_mutation',
  'coverage_without_runtime_evidence',
  'input_normalizer_missing',
  'run_smoke_failed',
  'html_incomplete',
  'trailing_after_html',
  'canvas_not_responsive',
  'missing_user_input',
  'missing_controls_metadata',
  'missing_coverage_metadata',
  'missing_reachability_metadata',
  'missing_quality_metadata',
  'frontend_visual_smoke_failed',
  'generic_validation_failure',
];

/**
 * 通用候选行筛选关键词。subtype-specific 关键词不写在这里，由 registry
 * 的 checker 通过 `classifyFailure` 自己识别。
 */
const GENERIC_CANDIDATE_KEYWORDS =
  /validator|validation failed|runSmokeTest|reachability|coverage|snapshot|step\(\)|input\.forEach|normalizeInput|string\[\]|object map|canvas|browser visual smoke|frontend browser validation|console errors|page errors|响应式|裁切|gameplayMechanics|合约|缺少|失败|不能证明|无法证明|对象存在|机制注册|覆盖声明|直接授予|直接修改|宽松距离|测试模式修改|真实流程里获得|真实输入完成/i;

/**
 * 动态拼装 directCodePattern：generic 列表 + 所有已注册 subtype 的 codes。
 *
 * subtype-specific code 集合通过 `subtypeRepairCodes()` 拿（当前只接 platformer，
 * 后续每加一个 subtype 在该 helper 内补一行 import + 合并即可，主流程不动）。
 */
function buildDirectCodePattern(): RegExp {
  const allCodes = [...new Set([...GENERIC_ISSUE_CODES, ...subtypeRepairCodes()])];
  return new RegExp(`\\b(${allCodes.join('|')})\\b`, 'g');
}

/**
 * 收集 subtype-specific 的 repair codes — 当前只接 platformer。
 *
 * 后续 runner / tower-defense 加进来时，每个 subtype 在自己的 repairCodes.ts
 * 提供 export，这里 import 进来再 concat 即可（与 buildSubtypeRegistryClassifiers
 * 同样的模式，主入口零 platformer 关键词依旧成立）。
 */
function subtypeRepairCodes(): string[] {
  // checker 必须先注册到 registry，才把它的 codes 算进 directCodePattern；
  // 这样测试 / 临时 stub 可以通过 clear() 清空 registry 来隔离。
  if (gameSubtypeRegistry.list().length === 0) return [];
  return PLATFORMER_REPAIR_CODES.map((entry) => entry.code);
}

export function inferArtifactRepairIssueCodesFromText(text: string): ArtifactRepairIssueCode[] {
  if (!text.trim()) return [];
  const issueCodes = new Set<ArtifactRepairIssueCode>();
  const directCodePattern = buildDirectCodePattern();

  for (const match of text.matchAll(directCodePattern)) {
    issueCodes.add(match[1] as ArtifactRepairIssueCode);
  }

  const candidateLines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .filter(
      (line) =>
        GENERIC_CANDIDATE_KEYWORDS.test(line) ||
        // subtype checker 的 pattern 命中也算候选行（避免漏掉只含 platformer 关键词的描述）
        classifyFailureViaRegistry(line) !== undefined,
    );

  for (const line of candidateLines.length > 0 ? candidateLines : [text]) {
    const classified = classifyFailure(line).code;
    if (classified !== 'generic_validation_failure') {
      issueCodes.add(classified);
    }
  }

  return [...issueCodes];
}

function severityForCode(code: ArtifactRepairIssueCode): ArtifactRepairIssueSeverity {
  return code === 'generic_validation_failure' ? 'warning' : 'error';
}

function mergeIssues(failures: string[]): ArtifactRepairIssue[] {
  const issues = new Map<ArtifactRepairIssueCode, ArtifactRepairIssue>();

  for (const failure of failures) {
    const classification = classifyFailure(failure);
    const evidence = compactText(failure);
    const existing = issues.get(classification.code);

    if (existing) {
      if (!existing.evidence.includes(evidence)) {
        existing.evidence.push(evidence);
      }
      continue;
    }

    issues.set(classification.code, {
      code: classification.code,
      severity: severityForCode(classification.code),
      message: messageForCode(classification.code),
      evidence: [evidence],
      repairInstruction: classification.repairInstruction,
    });
  }

  return [...issues.values()];
}

function messageForCode(code: ArtifactRepairIssueCode): string {
  // subtype-specific code 走 registry — 文案归 PlatformerChecker 持有
  if (PLATFORMER_REPAIR_CODE_SET.has(code as PlatformerRepairCode)) {
    const entry = PLATFORMER_REPAIR_CODES.find((e) => e.code === code);
    if (entry) return entry.message;
  }
  switch (code as GenericArtifactRepairIssueCode) {
    case 'lost_interactive_contract':
      return 'Interactive artifact contract was removed during repair.';
    case 'html_incomplete':
      return 'HTML document is incomplete.';
    case 'trailing_after_html':
      return 'Content exists after the closing HTML tag.';
    case 'canvas_not_responsive':
      return 'Canvas layout is not responsive to the browser viewport.';
    case 'missing_test_contract':
      return 'Interactive test contract is missing.';
    case 'malformed_test_contract':
      return 'Interactive test contract is malformed or has orphaned duplicate tails.';
    case 'missing_contract_start':
      return 'Test contract is missing start().';
    case 'missing_contract_snapshot':
      return 'Test contract is missing snapshot() or required snapshot fields.';
    case 'missing_contract_smoke':
      return 'Test contract is missing runSmokeTest().';
    case 'missing_snapshot_metric':
      return 'Reachability metric is absent from snapshot().';
    case 'non_executable_reachability_input':
      return 'Reachability step uses input that cannot be dispatched.';
    case 'control_no_state_change':
      return 'Declared controls do not change observable state.';
    case 'level_coverage_incomplete':
      return 'Smoke coverage does not prove all authored levels or scenarios.';
    case 'smoke_missing_coverage':
      return 'Runtime smoke result is missing required coverage.';
    case 'shortcut_state_mutation':
      return 'Test contract mutates gameplay state through shortcuts.';
    case 'coverage_without_runtime_evidence':
      return 'Smoke coverage is claimed without runtime evidence.';
    case 'input_normalizer_missing':
      return 'Input normalization is missing or brittle.';
    case 'run_smoke_failed':
      return 'Runtime smoke execution failed.';
    case 'missing_user_input':
      return 'Playable input entry is missing.';
    case 'missing_controls_metadata':
      return 'Controls metadata is missing or not dispatchable.';
    case 'missing_coverage_metadata':
      return 'Authored scope metadata is missing.';
    case 'missing_reachability_metadata':
      return 'Reachability or progress metadata is missing.';
    case 'missing_quality_metadata':
      return 'Quality or acceptance metadata is missing.';
    case 'frontend_visual_smoke_failed':
      return 'Frontend browser validation failed.';
    case 'generic_validation_failure':
      return 'Validation failed with an unclassified issue.';
  }
}

function buildMustFix(issues: ArtifactRepairIssue[]): string[] {
  return issues.map((issue) => `${issue.code}: ${issue.repairInstruction}`);
}

function buildRepairHints(issues: ArtifactRepairIssue[]): string[] {
  const hints: string[] = [];
  if (issues.some((issue) => issue.code === 'missing_reachability_metadata')) {
    hints.push(
      'required metadata field: add progressPlan or reachability as an actual array property on __GAME_META__ or __INTERACTIVE_META__. A generic progress, coverage, objectives, coreLoop, or qualityPlan object does not satisfy this validator check.',
      'progressPlan template: __GAME_META__.progressPlan = [{ label: "move right", input: "ArrowRight", frames: 24, metric: "player.x", expect: "increase" }, { label: "jump arc", input: ["ArrowRight", "Space"], frames: 20, metric: "player.y", expect: "change" }]; runSmokeTest() must execute the same inputs and assert before/after snapshot changes.',
      'For multi-level artifacts, include at least one executable reachability step per authored level or scenario; do not count direct level loading as progression evidence unless runSmokeTest also proves that level responds to real input.',
    );
  }
  if (issues.some((issue) => issue.code === 'missing_snapshot_metric' || issue.code === 'non_executable_reachability_input' || issue.code === 'control_no_state_change')) {
    hints.push(
      'Reachability repair template: use exact snapshot paths; Do not assert score/progress/win/gate/ability changes after generic movement. Missing metric "progress" should become player.x/player.y/player.vy unless progress is real.',
      'Reachability inputs must be real dispatchable controls from metadata, for example "ArrowRight", "Space", or ["ArrowRight", "Space"]; never "move", "jump", "combo", "progress", or "none".',
      'Either change the metric to a local movement field or adjust the scenario layout so the reward/gate is reached deterministically through live collision.',
    );
  }
  if (issues.some((issue) => issue.code === 'coverage_without_runtime_evidence' || issue.code === 'shortcut_state_mutation')) {
    hints.push(
      'Runtime evidence must come from start/reset/step/snapshot using the same physics, collision, reward, hazard, and progression code that the player uses; do not grant abilities, collect rewards, move levels, or mark wins directly inside step() or runSmokeTest().',
      'Do not use fallback coverage like enemy_present, spikes_present, ability treat exists, door reachable, mechanics registered, or object exists. If the player cannot trigger it, change the level layout, collision size, spawn path, or smoke input path until a before/after snapshot proves the state change.',
      'Only add coverage after checks such as lives decreased, score increased from a stomp, ability changed from false to true, treatsCollected increased, level/mode changed through door rules, or player coordinates changed after dispatched controls.',
    );
  }
  if (issues.some((issue) => issue.code === 'input_normalizer_missing')) {
    hints.push(
      'Input normalizer template: convert string, string[], object map, null, and empty input to one pressed-key map before step() checks keys or calls forEach.',
    );
  }
  if (issues.some((issue) => issue.code === 'canvas_not_responsive')) {
    hints.push(
      'Keep the game resolution stable for drawing, but make the browser layout responsive: wrap the canvas, set max-width/max-height against the viewport, preserve aspect-ratio, and avoid overflow cropping the playfield.',
    );
  }
  if (issues.some((issue) => issue.code === 'frontend_visual_smoke_failed')) {
    hints.push(
      'Frontend validation is browser evidence. Fix actual page load/render problems: remove thrown errors, keep the canvas framed in desktop and mobile viewports, draw nonblank content after start/reset/step, and expose __GAME_META__/__GAME_TEST__ on the same window used by the rendered game.',
    );
  }
  // subtype-specific hints — 走各 checker 自己的 repairCodes 表
  hints.push(...collectSubtypeRepairHints(issues));
  return hints;
}

/**
 * 把 issues 里 subtype-specific 的失败码翻成 repair hints。
 *
 * 当前只接 platformer；未来加 runner / tower-defense 时把分支补全即可。
 * 多个相同 issue 命中时只展开一次（按 code 去重），保持 hint 列表稳定。
 */
function collectSubtypeRepairHints(issues: readonly ArtifactRepairIssue[]): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  // platformer：missing_gameplay_mechanics 用专属 hints；
  // gameplay_mechanics_without_runtime_evidence + ability_gate_without_reachability
  // 共享 runtime 证据 hints（与原 buildRepairHints 行为一致）。
  if (issues.some((i) => i.code === 'missing_gameplay_mechanics')) {
    const entry = PLATFORMER_REPAIR_CODES.find((e) => e.code === 'missing_gameplay_mechanics');
    if (entry) appendUnique(hints, seen, entry.hints);
  }
  if (
    issues.some(
      (i) =>
        i.code === 'gameplay_mechanics_without_runtime_evidence' ||
        i.code === 'ability_gate_without_reachability',
    )
  ) {
    // 这两条共用同一组 hints — 取 ability_gate_without_reachability 的（与原逻辑一致）
    const entry = PLATFORMER_REPAIR_CODES.find((e) => e.code === 'ability_gate_without_reachability');
    if (entry) appendUnique(hints, seen, entry.hints);
  }
  return hints;
}

function appendUnique(target: string[], seen: Set<string>, items: readonly string[]): void {
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      target.push(item);
    }
  }
}

function buildSummary(summary: GameArtifactValidationSummary, issues: ArtifactRepairIssue[]): string {
  if (!summary.shouldValidate) {
    return `No game-artifact repair needed; inferred kind is ${summary.inferredKind}.`;
  }
  if (summary.passed && issues.length === 0) {
    return `Game artifact validation passed for ${summary.inferredKind}.`;
  }

  const codes = issues.map((issue) => issue.code).join(', ');
  return `Game artifact validation failed for ${summary.inferredKind}; repair ${issues.length} issue${issues.length === 1 ? '' : 's'}: ${codes}.`;
}

export function createArtifactRepairSpec(summary: GameArtifactValidationSummary): ArtifactRepairSpec {
  const issues = mergeIssues(summary.failures);

  return {
    kind: 'game_artifact_repair',
    summary: buildSummary(summary, issues),
    issues,
    mustFix: buildMustFix(issues),
    allowedEditScope: [
      'Edit only the generated artifact file and its embedded metadata/test contract.',
      'Keep the artifact self-contained unless the original task explicitly allowed external assets.',
      'Do not change validator or runtime engine code while repairing artifact output.',
    ],
    nextAction: issues.length > 0
      ? 'Regenerate or patch the artifact, then run game artifact validation again with runtime smoke when available.'
      : 'No repair action required.',
  };
}

export function formatArtifactRepairSpecForPrompt(spec: ArtifactRepairSpec): string {
  const repairHints = buildRepairHints(spec.issues);
  const lines = [
    `kind: ${spec.kind}`,
    `summary: ${compactText(spec.summary, 180)}`,
  ];
  if (repairHints.length > 0) {
    lines.push('hints:');
    for (const hint of repairHints.slice(0, 4)) {
      lines.push(`- ${compactText(hint, 200)}`);
    }
  }
  lines.push('issues:');
  for (const issue of spec.issues.slice(0, MAX_PROMPT_ISSUES)) {
    lines.push(`- code: ${JSON.stringify(issue.code)}`);
    lines.push(`  message: ${compactText(issue.message, 90)}`);
    lines.push(`  fix: ${compactText(issue.repairInstruction, 180)}`);
    if (issue.evidence.length > 0) {
      lines.push(`  evidence: ${compactText(issue.evidence.slice(0, 1).join(' | '), 120)}`);
    }
  }

  const compact = lines.join('\n');
  const body = compact.length <= MAX_PROMPT_CHARS
    ? compact
    : `${compact.slice(0, MAX_PROMPT_CHARS - 32).trimEnd()}\ntruncated: true`;

  return `<artifact_repair_spec>\n${body}\n</artifact_repair_spec>`;
}
