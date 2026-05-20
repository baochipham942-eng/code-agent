import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import type { BrowserVisualSmokeSummary } from './browser/types';
import {
  cloneBrowserVisualSmoke,
  runBrowserVisualSmoke,
  DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS,
} from './browser/visualSmoke';
import {
  DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS,
  runRuntimeSmoke,
  type RuntimeSmokeSummary,
} from './gameArtifactRuntimeSmoke';
import { gameSubtypeRegistry } from './gameArtifactSubtypeRegistry';

export type { RuntimeSmokeSummary } from './gameArtifactRuntimeSmoke';

export interface GameArtifactValidationSummary {
  shouldValidate: boolean;
  inferredKind: 'game' | 'interactive_app' | 'other';
  isComplete: boolean;
  hasTrailingHtmlContent?: boolean;
  passed: boolean;
  failures: string[];
  checks: string[];
  runtimeSmoke?: RuntimeSmokeSummary;
  browserVisualSmoke?: BrowserVisualSmokeSummary;
}

export interface GameArtifactValidationOptions {
  runRuntimeSmoke?: boolean;
  runtimeSmokeTimeoutMs?: number;
  runBrowserVisualSmoke?: boolean;
  browserVisualSmokeTimeoutMs?: number;
}

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const VALIDATION_CACHE_MAX_ENTRIES = 32;
const validationCache = new Map<string, GameArtifactValidationSummary>();

function cloneRuntimeSmoke(summary: RuntimeSmokeSummary): RuntimeSmokeSummary {
  return {
    attempted: summary.attempted,
    skipped: summary.skipped,
    passed: summary.passed,
    failures: [...summary.failures],
    checks: [...summary.checks],
  };
}

function cloneValidationSummary(summary: GameArtifactValidationSummary): GameArtifactValidationSummary {
  return {
    ...summary,
    failures: [...summary.failures],
    checks: [...summary.checks],
    runtimeSmoke: summary.runtimeSmoke ? cloneRuntimeSmoke(summary.runtimeSmoke) : undefined,
    browserVisualSmoke: summary.browserVisualSmoke
      ? cloneBrowserVisualSmoke(summary.browserVisualSmoke)
      : undefined,
  };
}

function makeValidationCacheKey(
  filePath: string,
  content: string,
  options: GameArtifactValidationOptions,
): string {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const runtimeTimeoutMs = options.runRuntimeSmoke
    ? options.runtimeSmokeTimeoutMs ?? DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS
    : 0;
  const visualTimeoutMs = options.runBrowserVisualSmoke
    ? options.browserVisualSmokeTimeoutMs ?? DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS
    : 0;
  return [
    path.resolve(filePath),
    contentHash,
    options.runRuntimeSmoke ? 'runtime' : 'static',
    runtimeTimeoutMs,
    options.runBrowserVisualSmoke ? 'visual' : 'no-visual',
    visualTimeoutMs,
  ].join('\0');
}

function readCachedValidation(cacheKey: string): GameArtifactValidationSummary | undefined {
  const cached = validationCache.get(cacheKey);
  if (!cached) return undefined;
  validationCache.delete(cacheKey);
  validationCache.set(cacheKey, cached);
  return cloneValidationSummary(cached);
}

function writeCachedValidation(cacheKey: string, summary: GameArtifactValidationSummary): GameArtifactValidationSummary {
  validationCache.set(cacheKey, cloneValidationSummary(summary));
  while (validationCache.size > VALIDATION_CACHE_MAX_ENTRIES) {
    const oldestKey = validationCache.keys().next().value;
    if (!oldestKey) break;
    validationCache.delete(oldestKey);
  }
  return cloneValidationSummary(summary);
}

const GAME_SIGNAL_PATTERNS = [
  /window\.__GAME_META__/i,
  /window\.__GAME_TEST__/i,
  /id=["']game-meta["']/i,
  /window\.__INTERACTIVE_META__[\s\S]{0,1200}\bdomain\s*:\s*['"`]game['"`]/i,
  /id=["']interactive-meta["'][\s\S]{0,1200}"domain"\s*:\s*"game"/i,
];

const INTERACTIVE_TEST_CONTRACT_PATTERNS = [
  /window\.__INTERACTIVE_TEST__\s*=/i,
  /window\.__GAME_TEST__\s*=/i,
];

const INTERACTIVE_TEST_START_PATTERNS = [
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bstart\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__GAME_TEST__[\s\S]{0,3000}\bstart\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bstart\s*\(/i,
  /__GAME_TEST__[\s\S]{0,3000}\bstart\s*\(/i,
  /__INTERACTIVE_TEST__\s*=\s*\{[\s\S]{0,1000}\bstart\s*(?:,|\})/i,
  /__GAME_TEST__\s*=\s*\{[\s\S]{0,1000}\bstart\s*(?:,|\})/i,
];

const INTERACTIVE_TEST_SNAPSHOT_PATTERNS = [
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bsnapshot\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__GAME_TEST__[\s\S]{0,3000}\bsnapshot\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bsnapshot\s*\(/i,
  /__GAME_TEST__[\s\S]{0,3000}\bsnapshot\s*\(/i,
  /__INTERACTIVE_TEST__\s*=\s*\{[\s\S]{0,1000}\bsnapshot\s*(?:,|\})/i,
  /__GAME_TEST__\s*=\s*\{[\s\S]{0,1000}\bsnapshot\s*(?:,|\})/i,
];

const INTERACTIVE_TEST_RESET_PATTERNS = [
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\breset\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__GAME_TEST__[\s\S]{0,3000}\breset\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\breset\s*\(/i,
  /__GAME_TEST__[\s\S]{0,3000}\breset\s*\(/i,
  /__INTERACTIVE_TEST__\s*=\s*\{[\s\S]{0,1000}\breset\s*(?:,|\})/i,
  /__GAME_TEST__\s*=\s*\{[\s\S]{0,1000}\breset\s*(?:,|\})/i,
];

const INTERACTIVE_TEST_STEP_PATTERNS = [
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bstep\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__GAME_TEST__[\s\S]{0,3000}\bstep\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bstep\s*\(/i,
  /__GAME_TEST__[\s\S]{0,3000}\bstep\s*\(/i,
  /__INTERACTIVE_TEST__\s*=\s*\{[\s\S]{0,1000}\bstep\s*(?:,|\})/i,
  /__GAME_TEST__\s*=\s*\{[\s\S]{0,1000}\bstep\s*(?:,|\})/i,
];

const INTERACTIVE_TEST_SMOKE_PATTERNS = [
  /__INTERACTIVE_TEST__[\s\S]{0,5000}\brunSmokeTest\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__GAME_TEST__[\s\S]{0,5000}\brunSmokeTest\s*[:=]\s*(?:async\s*)?(?:function|\(?)/i,
  /__INTERACTIVE_TEST__[\s\S]{0,5000}\brunSmokeTest\s*\(/i,
  /__GAME_TEST__[\s\S]{0,5000}\brunSmokeTest\s*\(/i,
  /__INTERACTIVE_TEST__\s*=\s*\{[\s\S]{0,1000}\brunSmokeTest\s*(?:,|\})/i,
  /__GAME_TEST__\s*=\s*\{[\s\S]{0,1000}\brunSmokeTest\s*(?:,|\})/i,
];

const CONTROL_PATTERNS = [
  /\bkeydown\b/i,
  /\bkeyup\b/i,
  /\bpointerdown\b/i,
  /\btouchstart\b/i,
  /\bclick\b/i,
];

const META_COVERAGE_PATTERNS = [
  /__(?:GAME|INTERACTIVE)_META__[\s\S]{0,2000}(?:\b(?:levels|segments|scenarios|objectives|stages|missions)\s*:|["'](?:levels|segments|scenarios|objectives|stages|missions)["']\s*:)/i,
  /__(?:GAME|INTERACTIVE)_TEST__[\s\S]{0,3000}(?:\b(?:levels|segments|scenarios|objectives|stages|missions)\s*:|["'](?:levels|segments|scenarios|objectives|stages|missions)["']\s*:)/i,
  /(?:game|interactive)-meta[\s\S]{0,2000}"(?:levels|segments|scenarios|objectives|stages|missions)"\s*:/i,
];

const META_CONTROL_PATTERNS = [
  /__GAME_META__[\s\S]{0,2000}\bcontrols\b/i,
  /game-meta[\s\S]{0,2000}"controls"/i,
  /__INTERACTIVE_META__[\s\S]{0,2000}\bcontrols\b/i,
  /interactive-meta[\s\S]{0,2000}"controls"/i,
  /__GAME_TEST__[\s\S]{0,3000}\bcontrols\b/i,
  /__INTERACTIVE_TEST__[\s\S]{0,3000}\bcontrols\b/i,
];

const META_REACHABILITY_PATTERNS = [
  /__GAME_META__[\s\S]{0,3000}\b(reachability|smokePlan|progressPlan|validation)\b/i,
  /game-meta[\s\S]{0,3000}"(reachability|smokePlan|progressPlan|validation)"/i,
  /__INTERACTIVE_META__[\s\S]{0,3000}\b(reachability|smokePlan|progressPlan|validation)\b/i,
  /interactive-meta[\s\S]{0,3000}"(reachability|smokePlan|progressPlan|validation)"/i,
  /__GAME_TEST__[\s\S]{0,5000}\b(reachability|smokePlan|progressPlan|validation)\b/i,
  /__INTERACTIVE_TEST__[\s\S]{0,5000}\b(reachability|smokePlan|progressPlan|validation)\b/i,
];

const META_REACHABILITY_NEAR_MISS_PATTERNS = [
  /__(?:GAME|INTERACTIVE)_META__[\s\S]{0,4000}(?:\b(?:progress|coverage)\s*:|["'](?:progress|coverage)["']\s*:)/i,
  /(?:game|interactive)-meta[\s\S]{0,4000}"(?:progress|coverage)"\s*:/i,
];

const META_QUALITY_PATTERNS = [
  /__GAME_META__[\s\S]{0,4000}\b(qualityPlan|actorReadable|mechanics|rewards|risks|levelsCovered|allAuthoredLevelsReachable)\b/i,
  /game-meta[\s\S]{0,4000}"(qualityPlan|actorReadable|mechanics|rewards|risks|levelsCovered|allAuthoredLevelsReachable)"/i,
  /__INTERACTIVE_META__[\s\S]{0,4000}\b(qualityPlan|actorReadable|mechanics|rewards|risks|levelsCovered|allAuthoredLevelsReachable)\b/i,
  /interactive-meta[\s\S]{0,4000}"(qualityPlan|actorReadable|mechanics|rewards|risks|levelsCovered|allAuthoredLevelsReachable)"/i,
  /__GAME_TEST__[\s\S]{0,5000}\b(qualityPlan|actorReadable|mechanics|rewards|risks|levelsCovered|allAuthoredLevelsReachable)\b/i,
  /__INTERACTIVE_TEST__[\s\S]{0,5000}\b(qualityPlan|actorReadable|mechanics|rewards|risks|levelsCovered|allAuthoredLevelsReachable)\b/i,
];

const STRONG_INTERACTIVE_PATTERNS = [
  /window\.__INTERACTIVE_TEST__/i,
  /window\.__INTERACTIVE_META__/i,
  /window\.__GAME_TEST__/i,
  /window\.__GAME_META__/i,
];

const GAMEPLAY_HINT_PATTERNS = [
  /\b(player|avatar|character|hero|actor)\b/i,
  /\b(corgi|dog|cat|sprite|body|head|tail)\b/i,
  /\b(level|stage|mission|goal|checkpoint|progress)\b/i,
  /\b(platform|ground|jump|gravity|vx|vy|collision|aabb)\b/i,
  /\b(score|coin|reward|powerUp|power-up|collectible)\b/i,
  /\b(enemy|hazard|spike|pit|trap|lives|health|jump)\b/i,
];

const CONTRACT_FUNCTION_SCAN_LIMIT = 9000;

interface ContractSnippet {
  text: string;
  start: number;
  end: number;
}

function hasExplicitGameSignal(content: string): boolean {
  return GAME_SIGNAL_PATTERNS.some((pattern) => pattern.test(content));
}

function hasStrongInteractiveSignal(content: string): boolean {
  if (STRONG_INTERACTIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return true;
  }

  const hasCanvas = /<canvas\b/i.test(content);
  const hasRealtimeLoop = /\brequestAnimationFrame\b/i.test(content) || /\bsetInterval\b/i.test(content);
  const hasInput = CONTROL_PATTERNS.some((pattern) => pattern.test(content));
  const gameplaySignalCount = GAMEPLAY_HINT_PATTERNS.filter((pattern) => pattern.test(content)).length;

  return hasCanvas && hasInput && gameplaySignalCount >= 3 && (hasRealtimeLoop || gameplaySignalCount >= 4);
}

function inferArtifactKind(content: string): 'game' | 'interactive_app' | 'other' {
  if (hasExplicitGameSignal(content)) {
    return 'game';
  }
  if (hasStrongInteractiveSignal(content) || /<canvas\b/i.test(content) || /<script\b/i.test(content)) {
    return 'interactive_app';
  }
  return 'other';
}

function looksLikeCompleteHtml(content: string): boolean {
  if (!content.trim()) return false;
  if (!/<html\b/i.test(content) && !/<!doctype html/i.test(content)) return false;
  return /<\/html>\s*$/i.test(content.trim());
}

function hasTrailingContentAfterHtml(content: string): boolean {
  const match = /<\/html>/ig;
  let lastMatch: RegExpExecArray | null = null;
  for (;;) {
    const next = match.exec(content);
    if (!next) break;
    lastMatch = next;
  }
  if (!lastMatch) return false;
  const trailing = content.slice(lastMatch.index + lastMatch[0].length);
  return /\S/.test(trailing);
}

function findOpeningBrace(content: string, startIndex: number): number {
  for (let index = Math.max(0, startIndex); index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') return index;
    if (char === ';' || char === '\n' && index - startIndex > 500) break;
  }
  return -1;
}

function extractFunctionSnippet(content: string, functionName: string): string {
  const patterns = [
    new RegExp(`\\b${functionName}\\s*[:=]\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, 'i'),
    new RegExp(`\\b${functionName}\\s*[:=]\\s*(?:async\\s*)?(?:function\\s*)?\\([^)]*\\)\\s*\\{`, 'i'),
    new RegExp(`\\b${functionName}\\s*\\([^)]*\\)\\s*\\{`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match) continue;
    const openBrace = findOpeningBrace(content, match.index);
    if (openBrace < 0) continue;

    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    const endLimit = Math.min(content.length, openBrace + CONTRACT_FUNCTION_SCAN_LIMIT);
    for (let index = openBrace; index < endLimit; index += 1) {
      const char = content[index];
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return content.slice(match.index, index + 1);
        }
      }
    }

    return content.slice(match.index, endLimit);
  }

  return '';
}

function findBalancedObjectAssignmentSnippet(content: string, assignmentPattern: RegExp): ContractSnippet | null {
  const match = assignmentPattern.exec(content);
  if (!match) return null;
  const start = match.index;
  const openBrace = findOpeningBrace(content, start);
  if (openBrace < 0) return null;

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openBrace; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        while (/\s/.test(content[end] || '')) end += 1;
        if (content[end] === ';') end += 1;
        return {
          text: content.slice(start, end),
          start,
          end,
        };
      }
    }
  }

  return null;
}

function extractInteractiveContractSnippet(content: string): ContractSnippet | null {
  return findBalancedObjectAssignmentSnippet(content, /window\.__INTERACTIVE_TEST__\s*=\s*\{/i)
    || findBalancedObjectAssignmentSnippet(content, /window\.__GAME_TEST__\s*=\s*\{/i);
}

function extractGameMetadataSnippet(content: string): ContractSnippet | null {
  return findBalancedObjectAssignmentSnippet(content, /window\.__GAME_META__\s*=\s*\{/i)
    || findBalancedObjectAssignmentSnippet(content, /window\.__INTERACTIVE_META__\s*=\s*\{/i);
}

function hasOrphanedContractTail(content: string, contractSnippet: ContractSnippet | null): boolean {
  if (!contractSnippet) return false;
  const trailingBeforeScriptFooter = content
    .slice(contractSnippet.end)
    .split(/<\/script\b|\/\/\s*Auto-run smoke test|if\s*\(\s*typeof\s+window\s*!==\s*['"]undefined['"]/i)[0] || '';
  return /\n\s*(?:start|reset|snapshot|step|runSmokeTest)\s*\([^)]*\)\s*\{/.test(trailingBeforeScriptFooter);
}

function hasLargeProximityShortcut(snippet: string): boolean {
  const thresholds = [...snippet.matchAll(/\b(?:dx|dy|distance|dist)\s*<\s*(\d+(?:\.\d+)?)/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return thresholds.some((value) => value >= 160);
}

function findLargeFixedCanvas(content: string): { width?: number; height?: number } | null {
  for (const match of content.matchAll(/<canvas\b[^>]*>/gi)) {
    const tag = match[0];
    const width = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
    const height = Number(/\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
    if ((Number.isFinite(width) && width >= 700) || (Number.isFinite(height) && height >= 450)) {
      return {
        width: Number.isFinite(width) ? width : undefined,
        height: Number.isFinite(height) ? height : undefined,
      };
    }
  }
  return null;
}

function hasResponsiveCanvasSizing(content: string): boolean {
  const canvasResponsivePattern =
    /(?:canvas|#game|#gameCanvas|\.game-canvas|\.canvas-wrap|\.game-wrap|\.viewport)[\s\S]{0,700}(?:max-width\s*:\s*[^;}]*(?:100%|100vw|calc|min|clamp)|max-height\s*:\s*[^;}]*(?:100%|100vh|calc|min|clamp)|width\s*:\s*[^;}]*(?:100%|100vw|calc|min|clamp)|height\s*:\s*auto|aspect-ratio\s*:|vmin|dvh|svh)/i;
  const inlineResponsivePattern =
    /<canvas\b[^>]*\bstyle\s*=\s*["'][^"']*(?:max-width\s*:\s*[^;"']*(?:100%|100vw|calc|min|clamp)|width\s*:\s*[^;"']*(?:100%|100vw|calc|min|clamp)|height\s*:\s*auto|aspect-ratio\s*:)[^"']*["']/i;
  return canvasResponsivePattern.test(content) || inlineResponsivePattern.test(content);
}

function hasCanvasViewportCroppingRisk(content: string): boolean {
  return /\boverflow\s*:\s*hidden\b/i.test(content)
    || /(?:body|html|\.viewport|\.game-wrap|\.canvas-wrap)[\s\S]{0,400}\bheight\s*:\s*(?:100vh|100dvh|100svh)\b/i.test(content)
    || /(?:body|html|\.viewport|\.game-wrap|\.canvas-wrap)[\s\S]{0,400}\b(?:display\s*:\s*flex|place-items\s*:\s*center|align-items\s*:\s*center|justify-content\s*:\s*center)\b/i.test(content);
}

function hasDirectRunSmokeStateMutation(snippet: string): boolean {
  return snippet
    .split(/[;\n]/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) => !/^(?:const|let|var)\s+\w+\b/.test(statement))
    .some((statement) =>
      /\b(?:currentLevel|currentStage|currentMission|levelIndex|stageIndex|missionIndex)\s*(?:=|\+=|\+\+|--)/i.test(statement) ||
      /\b(?:loadLevel|nextLevel|completeLevel|winGame|finishGame)\s*\(/i.test(statement) ||
      /\b(?:mode|status|state)\s*=\s*['"`](?:won|win|complete|completed|cleared|success|levelComplete|gameWon)['"`]/i.test(statement) ||
      /\b(?:state|gameState|player|hero|actor|game|world|level|stage|mission|progress)\b[\w$.[\]'"]*\.\s*(?:score|points|coins|progress|cleared|completed|unlocked|won)\s*=\s*(?:true|\d+|['"`][^'"`]+['"`])/i.test(statement)
    );
}

/**
 * Subtype-aware mechanics dispatcher — 替代原 `validatePlatformerGameplayMechanics`。
 *
 * 思路：先尝试从 metadata snippet 里抠 subtype 字面量；抠不到就广撒网遍历 registry，
 * 让各 checker 自己判断要不要接（platformer checker 内部用 `isPlatformerArtifact`
 * 兜底文件名识别）。这样 main entry 不再持有任何 platformer 关键词。
 */
function detectSubtype(metadataSnippet: string): string | undefined {
  const match =
    /\b(?:subtype|genre|type)\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/i.exec(metadataSnippet) ||
    /"(?:subtype|genre|type)"\s*:\s*"([A-Za-z0-9_-]+)"/i.exec(metadataSnippet);
  return match?.[1]?.toLowerCase();
}

function dispatchSubtypeMechanicsValidation(
  content: string,
  filePath: string,
): { failures: string[]; checks: string[] } {
  const metadataSnippet = extractGameMetadataSnippet(content)?.text || content;
  const declaredSubtype = detectSubtype(metadataSnippet);

  // 优先看声明的 subtype；失败时把 content 喂给所有 checker 让它们自检
  // （eg. platformer 通过文件名兜底）。每个 checker 自己负责短路。
  const candidateSubtypes = declaredSubtype
    ? [declaredSubtype, ...gameSubtypeRegistry.list().filter((s) => s !== declaredSubtype)]
    : gameSubtypeRegistry.list();

  for (const subtype of candidateSubtypes) {
    const checker = gameSubtypeRegistry.get(subtype);
    if (!checker) continue;
    const result = checker.validateMechanics(content, {
      artifactRef: filePath,
      strict: false,
      metadata: { filePath },
    });
    // 第一个能识别（产生 checks 或 failures）的 subtype 接管，跳出。
    if (result.failures.length > 0 || result.checks.length > 0) {
      return { failures: [...result.failures], checks: [...result.checks] };
    }
  }
  return { failures: [], checks: [] };
}

function validateTestContractIntegrity(content: string, contractSnippet?: ContractSnippet | null): { failures: string[]; checks: string[] } {
  const failures: string[] = [];
  const checks: string[] = [];
  const contractContent = contractSnippet?.text || content;
  const stepSnippet = extractFunctionSnippet(contractContent, 'step');
  const smokeSnippet = extractFunctionSnippet(contractContent, 'runSmokeTest');

  if (!stepSnippet && !smokeSnippet) {
    return { failures, checks };
  }

  if (stepSnippet) {
    checks.push('test contract step body inspected for shortcut state mutation');
    const lowerStep = stepSnippet.toLowerCase();
    const mutatesRewardState =
      /\bcollected\s*=\s*true\b/i.test(stepSnippet) ||
      /\b(?:score|points|coins|reward\w*)\s*(?:\+\+|\+=)/i.test(stepSnippet) ||
      /\b(?:abilities|ability|powerups?|inventory)\s*(?:\[[^\]]+\]|\.\w+)\s*=\s*true\b/i.test(stepSnippet);
    const mutatesProgressionState =
      /\b(?:level|stage|mission|scenario)\s*\+\+/i.test(stepSnippet) ||
      /\b(?:mode|state|status)\s*=\s*['"`](?:won|win|complete|completed|cleared|success)['"`]/i.test(stepSnippet) ||
      /\b(?:loadLevel|nextLevel|completeLevel|winGame|finishGame)\s*\(/i.test(stepSnippet);
    const shortcutComment = /\bauto[-\s]?(?:collect|pickup|reach|grant|win|complete|advance)|test\s*mode\b/i.test(stepSnippet);

    if (mutatesRewardState && (hasLargeProximityShortcut(stepSnippet) || shortcutComment)) {
      failures.push('测试合约 step() 直接用宽松距离或测试模式修改奖励、收集物或能力状态；这会让奖励/能力不可达时也显示通过。请让 step() 只推进真实输入、碰撞和物理结果。');
    }

    if (mutatesProgressionState && (hasLargeProximityShortcut(stepSnippet) || shortcutComment || lowerStep.includes('door') || lowerStep.includes('goal'))) {
      failures.push('测试合约 step() 直接推进关卡、目标或胜利状态；这会掩盖路径不可达、门/目标无法真实到达的问题。请通过真实移动、碰撞、目标条件和关卡规则推进。');
    }
  }

  if (smokeSnippet) {
    checks.push('runSmokeTest body inspected for evidence-only coverage');
    if (/\b(?:abilities|ability|powerups?|inventory)\s*(?:\[[^\]]+\]|\.\w+)\s*=\s*true\b/i.test(smokeSnippet)) {
      failures.push('runSmokeTest 直接授予能力、道具或库存状态后再验证机制；这不能证明玩家能在真实流程里获得该能力。请用输入和碰撞先获得能力，再验证能力生效。');
    }

    if (hasDirectRunSmokeStateMutation(smokeSnippet)) {
      failures.push('runSmokeTest 直接修改进度、分数、关卡、胜利或解锁状态后再声明通过；这不能证明玩家能用真实输入完成该链路。请通过 start/reset/step/snapshot 驱动真实玩法，并用 before/after snapshot 证明变化。');
    }

    const coverageFromExistence =
      /\b(?:find|some|filter)\s*\([\s\S]{0,500}\b(?:ability|power|reward|collectible|item|upgrade)\b[\s\S]{0,900}\b(?:rewards|mechanics|stateChanges|coverage)\s*\.\s*(?:add|push)\s*\(/i.test(smokeSnippet) ||
      /\b(?:exists|present|defined|registered)\b[\s\S]{0,220}\b(?:mechanics?|risks?|rewards?|coverage|ability|upgrade|item)\b/i.test(smokeSnippet) ||
      /\b(?:mechanics?|risks?|rewards?|coverage|ability|upgrade|item)\b[\s\S]{0,220}\b(?:exists|present|defined|registered)\b/i.test(smokeSnippet);
    if (coverageFromExistence) {
      failures.push('runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。请用前后 snapshot 的真实状态变化证明承诺的交互。');
    }
  }

  return { failures, checks };
}

export async function validateGameArtifact(
  filePath: string,
  options: GameArtifactValidationOptions = {},
): Promise<GameArtifactValidationSummary> {
  const ext = path.extname(filePath).toLowerCase();
  if (!HTML_EXTENSIONS.has(ext)) {
    return {
      shouldValidate: false,
      inferredKind: 'other',
      isComplete: true,
      passed: true,
      failures: [],
      checks: [],
    };
  }

  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    return {
      shouldValidate: true,
      inferredKind: 'other',
      isComplete: false,
      passed: false,
      failures: [`无法读取生成的 HTML: ${error instanceof Error ? error.message : String(error)}`],
      checks: [],
    };
  }

  const inferredKind = inferArtifactKind(content);
  const isComplete = looksLikeCompleteHtml(content);
  const hasTrailingHtmlContent = hasTrailingContentAfterHtml(content);
  const shouldValidate = inferredKind === 'game' || hasStrongInteractiveSignal(content);
  const cacheKey = makeValidationCacheKey(filePath, content, options);
  const cached = readCachedValidation(cacheKey);
  if (cached) {
    return cached;
  }
  if (!shouldValidate) {
    return writeCachedValidation(cacheKey, {
      shouldValidate: false,
      inferredKind,
      isComplete,
      hasTrailingHtmlContent,
      passed: true,
      failures: [],
      checks: [],
    });
  }

  const failures: string[] = [];
  const checks: string[] = [];

  checks.push(`detected ${inferredKind} artifact with interactive delivery surface`);

  if (!isComplete) {
    failures.push('HTML 文件还没有完整闭合，先继续补齐内容再做游戏验收。');
  } else {
    checks.push('html document looks complete');
  }

  if (hasTrailingHtmlContent) {
    failures.push('HTML 在 </html> 之后还有非空内容；浏览器会忽略这部分脚本或数据，说明分块追加位置错误。');
  }

  const largeFixedCanvas = findLargeFixedCanvas(content);
  if (largeFixedCanvas && hasCanvasViewportCroppingRisk(content) && !hasResponsiveCanvasSizing(content)) {
    const dimensions = [largeFixedCanvas.width, largeFixedCanvas.height]
      .filter((value) => typeof value === 'number')
      .join('x');
    failures.push(`大型固定 canvas${dimensions ? ` (${dimensions})` : ''} 缺少响应式 CSS；窄窗口会裁切游戏画面。请保留内部分辨率，但给 canvas 或 wrapper 同时约束宽高，例如 max-width: calc(100vw - 16px)、max-height: calc(100dvh - 16px)、aspect-ratio、height:auto，确保 390px mobile viewport 内完整可见。`);
  } else if (largeFixedCanvas && hasResponsiveCanvasSizing(content)) {
    checks.push('responsive canvas sizing detected');
  }

  const hasStepProbe = INTERACTIVE_TEST_STEP_PATTERNS.some((pattern) => pattern.test(content));
  const hasResetProbe = INTERACTIVE_TEST_RESET_PATTERNS.some((pattern) => pattern.test(content));

  if (!CONTROL_PATTERNS.some((pattern) => pattern.test(content)) && !hasStepProbe) {
    failures.push('缺少明确的用户输入入口，无法确认玩家能实际操作游戏。');
  } else {
    checks.push('user input entry detected');
  }

  if (!META_COVERAGE_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('缺少可用于验收的关卡、片段、场景或目标元数据；工程层不能只凭源码猜游戏是否完整。');
  } else {
    checks.push('scenario/objective metadata detected');
  }

  if (!META_CONTROL_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('缺少 controls 元数据；工程层不知道该模拟什么输入来验证真实可操作性。');
  } else {
    checks.push('controls metadata detected');
  }

  if (!META_REACHABILITY_PATTERNS.some((pattern) => pattern.test(content))) {
    if (META_REACHABILITY_NEAR_MISS_PATTERNS.some((pattern) => pattern.test(content))) {
      failures.push('发现 progress/coverage 说明，但缺少 reachability/progressPlan/smokePlan/validation 元数据；__GAME_META__.progress、coverage 或字符串数组 acceptance 不算可执行验收计划。请添加 progressPlan 或 reachability 数组，每一步包含 input、frames、metric 和 expect。');
    } else {
      failures.push('缺少 reachability/progressPlan/smokePlan/validation 元数据；工程层无法验证目标、场景或关卡能被推进。');
    }
  } else {
    checks.push('reachability/progress metadata detected');
  }

  if (!META_QUALITY_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('缺少 qualityPlan/acceptance 级别的玩法承诺元数据；工程层无法判断角色可辨识、奖励/风险是否真实存在。');
  } else {
    checks.push('quality/acceptance metadata detected');
  }

  const subtypeMechanics = dispatchSubtypeMechanicsValidation(content, filePath);
  checks.push(...subtypeMechanics.checks);
  failures.push(...subtypeMechanics.failures);

  if (!INTERACTIVE_TEST_CONTRACT_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('缺少通用交互测试合约 window.__INTERACTIVE_TEST__ 或 window.__GAME_TEST__，工程层无法真实启动、输入并读取状态变化。');
  } else {
    checks.push('interactive test contract detected');
  }

  const interactiveContractSnippet = extractInteractiveContractSnippet(content);
  if (
    INTERACTIVE_TEST_CONTRACT_PATTERNS.some((pattern) => pattern.test(content))
    && !interactiveContractSnippet
  ) {
    failures.push('交互测试合约没有形成可平衡解析的对象字面量；请把 window.__INTERACTIVE_TEST__ / window.__GAME_TEST__ 修成一个直接赋值的平衡对象字面量，形如 window.__GAME_TEST__ = { start() {...}, reset(levelOrScenario) {...}, snapshot() {...}, step(inputState = {}, frames = 1) {...}, runSmokeTest() { return { passed, checks, failures, coverage }; } }; 不要放在注释、函数/类/IIFE/Object.assign 外壳里，也不要在对象闭合后留下重复或孤立的方法尾巴。');
  } else if (interactiveContractSnippet && hasOrphanedContractTail(content, interactiveContractSnippet)) {
    failures.push('交互测试合约闭合后仍然残留游离的 start/reset/snapshot/step/runSmokeTest 方法尾巴；请删除重复或孤立的 contract tail，再保留一份真实生效的测试合约。');
  }

  if (!INTERACTIVE_TEST_START_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('交互测试合约缺少 start()，验收无法从真实初始状态启动产物。');
  } else {
    checks.push('interactive start probe detected');
  }

  if (!INTERACTIVE_TEST_SNAPSHOT_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('交互测试合约缺少 snapshot()，验收无法读取主对象、进度或反馈变化。');
  } else {
    checks.push('interactive snapshot probe detected');
  }

  if (hasResetProbe) {
    checks.push('interactive reset probe detected');
  }

  if (hasStepProbe) {
    checks.push('interactive step probe detected');
  }

  const contractIntegrity = validateTestContractIntegrity(content, interactiveContractSnippet);
  checks.push(...contractIntegrity.checks);
  failures.push(...contractIntegrity.failures);

  const hasSmokeProbe = INTERACTIVE_TEST_SMOKE_PATTERNS.some((pattern) => pattern.test(content));
  if (!hasSmokeProbe) {
    failures.push('交互测试合约缺少 runSmokeTest()，验收无法用真实输入证明游戏可操作。');
  } else {
    checks.push('interactive runtime smoke probe detected');
  }

  let runtimeSmoke: RuntimeSmokeSummary | undefined;
  if (options.runRuntimeSmoke && isComplete && hasSmokeProbe) {
    runtimeSmoke = await runRuntimeSmoke(filePath, options.runtimeSmokeTimeoutMs ?? DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS);
    if (runtimeSmoke.passed) {
      checks.push(...runtimeSmoke.checks);
    } else {
      failures.push(...runtimeSmoke.failures);
    }
  }

  let browserVisualSmoke: BrowserVisualSmokeSummary | undefined;
  if (options.runBrowserVisualSmoke) {
    if (!isComplete) {
      browserVisualSmoke = {
        attempted: false,
        skipped: true,
        passed: true,
        failures: [],
        checks: ['browser visual smoke skipped: HTML is incomplete; finish the document before frontend validation.'],
      };
      checks.push(...browserVisualSmoke.checks);
    } else {
      browserVisualSmoke = await runBrowserVisualSmoke(
        filePath,
        options.browserVisualSmokeTimeoutMs ?? DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS,
      );
      if (browserVisualSmoke.passed) {
        checks.push(...browserVisualSmoke.checks);
      } else {
        failures.push(...browserVisualSmoke.failures);
      }
    }
  }

  return writeCachedValidation(cacheKey, {
    shouldValidate: true,
    inferredKind,
    isComplete,
    hasTrailingHtmlContent,
    passed: failures.length === 0,
    failures,
    checks,
    runtimeSmoke,
    browserVisualSmoke,
  });
}
