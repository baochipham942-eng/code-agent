import type { GameArtifactValidationSummary } from './gameArtifactValidator';
import { REPAIR_PROMPT_LIMITS } from '../../../shared/constants/repair';

export type ArtifactRepairIssueSeverity = 'error' | 'warning';

export type ArtifactRepairIssueCode =
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
  | 'missing_gameplay_mechanics'
  | 'gameplay_mechanics_without_runtime_evidence'
  | 'ability_gate_without_reachability'
  | 'missing_user_input'
  | 'missing_controls_metadata'
  | 'missing_coverage_metadata'
  | 'missing_reachability_metadata'
  | 'missing_quality_metadata'
  | 'frontend_visual_smoke_failed'
  | 'generic_validation_failure';

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
  if (/platformer[\s\S]{0,120}缺少 gameplayMechanics|gameplayMechanics[\s\S]{0,120}缺少 (?:enemies|blocks|abilities|gates|comboChallenge|stompable enemy|bumpable\/question block)|comboChallenge 必须组合/i.test(text)) {
    return {
      code: 'missing_gameplay_mechanics',
      repairInstruction: 'Add platformer gameplayMechanics to __GAME_META__ with enemies, blocks, abilities, gates, and comboChallenge, then implement those objects in live collision/update logic instead of only declaring them.',
    };
  }
  if (/gate 必须在获得技能后改变|requiresAbility|blocksAccessTo|技能.*(?:路线|可达|route)|ability 必须通过真实输入获得|Gate remained locked|gate remained locked/i.test(text)) {
    return {
      code: 'ability_gate_without_reachability',
      repairInstruction: 'Make one ability change movement or interaction rules and unlock a real gated route. snapshot() should expose abilities and gate/route state, and runSmokeTest() must prove ability false->true followed by gate/route unreachable->reachable.',
    };
  }
  if (/gameplayMechanics 缺少 runtime 证据|stompable enemy 必须通过 step\/runSmokeTest|bumpable\/question block 必须通过 step\/runSmokeTest|comboChallenge coverage 必须证明|Failed to bump block|Failed to stomp enemy|bump block or gain ability/i.test(text)) {
    return {
      code: 'gameplay_mechanics_without_runtime_evidence',
      repairInstruction: 'Repair runSmokeTest() so it drives step() through stomp enemy, bump block, gain ability, unlock gate/route, and combo challenge, recording coverage only after before/after snapshot changes prove each mechanic.',
    };
  }
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

export function inferArtifactRepairIssueCodesFromText(text: string): ArtifactRepairIssueCode[] {
  if (!text.trim()) return [];
  const issueCodes = new Set<ArtifactRepairIssueCode>();
  const directCodePattern =
    /\b(lost_interactive_contract|missing_contract_start|missing_contract_snapshot|missing_contract_smoke|missing_test_contract|malformed_test_contract|missing_snapshot_metric|non_executable_reachability_input|control_no_state_change|level_coverage_incomplete|smoke_missing_coverage|shortcut_state_mutation|coverage_without_runtime_evidence|input_normalizer_missing|run_smoke_failed|html_incomplete|trailing_after_html|canvas_not_responsive|missing_gameplay_mechanics|gameplay_mechanics_without_runtime_evidence|ability_gate_without_reachability|missing_user_input|missing_controls_metadata|missing_coverage_metadata|missing_reachability_metadata|missing_quality_metadata|frontend_visual_smoke_failed|generic_validation_failure)\b/g;

  for (const match of text.matchAll(directCodePattern)) {
    issueCodes.add(match[1] as ArtifactRepairIssueCode);
  }

  const candidateLines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .filter((line) =>
      /validator|validation failed|runSmokeTest|reachability|coverage|snapshot|step\(\)|input\.forEach|normalizeInput|string\[\]|object map|canvas|browser visual smoke|frontend browser validation|console errors|page errors|响应式|裁切|gameplayMechanics|platformer|stompable|comboChallenge|requiresAbility|blocksAccessTo|合约|缺少|失败|不能证明|无法证明|对象存在|机制注册|覆盖声明|直接授予|直接修改|宽松距离|测试模式修改|真实流程里获得|真实输入完成/i.test(line),
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
  switch (code) {
    case 'lost_interactive_contract':
      return 'Interactive artifact contract was removed during repair.';
    case 'html_incomplete':
      return 'HTML document is incomplete.';
    case 'trailing_after_html':
      return 'Content exists after the closing HTML tag.';
    case 'canvas_not_responsive':
      return 'Canvas layout is not responsive to the browser viewport.';
    case 'missing_gameplay_mechanics':
      return 'Platformer gameplay mechanics contract is missing or incomplete.';
    case 'gameplay_mechanics_without_runtime_evidence':
      return 'Platformer gameplay mechanics are declared without runtime evidence.';
    case 'ability_gate_without_reachability':
      return 'Platformer ability does not prove gated route reachability.';
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
  if (issues.some((issue) => issue.code === 'missing_gameplay_mechanics')) {
    hints.push(
      'Platformer metadata template: __GAME_META__.gameplayMechanics arrays only, never an object map; include stomp enemy, bump block, ability, reachableTarget gate, and comboChallenge.',
      'Implement collision code: stomp enemy -> enemiesDefeated/player.vy, bump block -> spawnedReward, ability false->true, gate -> reachableTarget or routeReachable.',
    );
  }
  if (issues.some((issue) => issue.code === 'gameplay_mechanics_without_runtime_evidence' || issue.code === 'ability_gate_without_reachability')) {
    hints.push(
      'Smoke template: snapshot before/after real step() calls, then prove stompEnemy, bumpBlock, gainAbility, unlockGate, comboChallenge only after assertions pass.',
      'If smoke says "Failed to bump block", "Failed to stomp enemy", or gate remained locked, move block/enemy/gate into a reachable real-controls path before claiming coverage.',
    );
  }
  return hints;
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
