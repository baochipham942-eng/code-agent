import { createHash } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  buildSystemChromeCdpArgs,
  findAvailablePort,
  resolveBrowserProvider,
} from '../../services/infra/browserProvider';

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

export interface RuntimeSmokeSummary {
  attempted: boolean;
  passed: boolean;
  failures: string[];
  checks: string[];
}

export interface BrowserVisualSmokeSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  failures: string[];
  checks: string[];
  diagnostics?: BrowserVisualSmokeDiagnostics;
}

export interface BrowserVisualSmokeDiagnostics {
  title?: string;
  metaPresent?: boolean;
  testPresent?: boolean;
  canvasCount?: number;
  nonblankCanvasCount?: number;
  visibleElements?: number;
  bodyTextLength?: number;
  consoleErrors?: string[];
  pageErrors?: string[];
  viewports?: Array<{
    name: string;
    width: number;
    height: number;
    canvasCount: number;
    nonblankCanvasCount: number;
    visibleElements: number;
    horizontalOverflow: boolean;
  }>;
}

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS = 7000;
const DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS = 10000;
const VALIDATION_CACHE_MAX_ENTRIES = 32;
const validationCache = new Map<string, GameArtifactValidationSummary>();

const BROWSER_VISUAL_SMOKE_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 780 },
] as const;

function cloneRuntimeSmoke(summary: RuntimeSmokeSummary): RuntimeSmokeSummary {
  return {
    attempted: summary.attempted,
    passed: summary.passed,
    failures: [...summary.failures],
    checks: [...summary.checks],
  };
}

function cloneBrowserVisualSmoke(summary: BrowserVisualSmokeSummary): BrowserVisualSmokeSummary {
  return {
    attempted: summary.attempted,
    skipped: summary.skipped,
    passed: summary.passed,
    failures: [...summary.failures],
    checks: [...summary.checks],
    diagnostics: summary.diagnostics
      ? {
          ...summary.diagnostics,
          consoleErrors: summary.diagnostics.consoleErrors ? [...summary.diagnostics.consoleErrors] : undefined,
          pageErrors: summary.diagnostics.pageErrors ? [...summary.diagnostics.pageErrors] : undefined,
          viewports: summary.diagnostics.viewports
            ? summary.diagnostics.viewports.map((viewport) => ({ ...viewport }))
            : undefined,
        }
      : undefined,
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
  /__GAME_META__[\s\S]{0,3000}\b(reachability|acceptance|smokePlan|progressPlan|validation)\b/i,
  /game-meta[\s\S]{0,3000}"(reachability|acceptance|smokePlan|progressPlan|validation)"/i,
  /__INTERACTIVE_META__[\s\S]{0,3000}\b(reachability|acceptance|smokePlan|progressPlan|validation)\b/i,
  /interactive-meta[\s\S]{0,3000}"(reachability|acceptance|smokePlan|progressPlan|validation)"/i,
  /__GAME_TEST__[\s\S]{0,5000}\b(reachability|acceptance|smokePlan|progressPlan|validation)\b/i,
  /__INTERACTIVE_TEST__[\s\S]{0,5000}\b(reachability|acceptance|smokePlan|progressPlan|validation)\b/i,
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

const PLATFORMER_META_PATTERNS = [
  /__(?:GAME|INTERACTIVE)_META__[\s\S]{0,2500}\b(?:subtype|genre|type)\s*:\s*['"`]platformer['"`]/i,
  /(?:game|interactive)-meta[\s\S]{0,2500}"(?:subtype|genre|type)"\s*:\s*"platformer"/i,
];

const PLATFORMER_ABILITY_PATTERN = /\b(doubleJump|double-jump|dash|shield|magnet|groundPound|ground-pound|wallJump|wall-jump)\b/i;

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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter(Boolean);
}

function normalizeRuntimeSmokeResult(value: unknown): RuntimeSmokeSummary {
  if (!value || typeof value !== 'object') {
    return {
      attempted: true,
      passed: false,
      failures: ['runSmokeTest 没有返回结构化结果。'],
      checks: [],
    };
  }

  const result = value as Record<string, unknown>;
  const checks = [
    ...stringArray(result.checks),
    ...stringArray(result.observations),
  ];
  const failures = stringArray(result.failures);
  const passed = result.passed === true && failures.length === 0;

  return {
    attempted: true,
    passed,
    checks,
    failures: passed ? [] : failures.length > 0 ? failures : ['runSmokeTest 返回未通过，但没有说明失败原因。'],
  };
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

function isPlatformerArtifact(content: string, filePath: string): boolean {
  const metadataSnippet = extractGameMetadataSnippet(content)?.text || content;
  if (PLATFORMER_META_PATTERNS.some((pattern) => pattern.test(metadataSnippet))) {
    return true;
  }
  if (/\bplatformer\b/i.test(path.basename(filePath)) && /window\.__(?:GAME|INTERACTIVE)_META__/i.test(content)) {
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

function validatePlatformerGameplayMechanics(content: string, filePath: string): { failures: string[]; checks: string[] } {
  if (!isPlatformerArtifact(content, filePath)) {
    return { failures: [], checks: [] };
  }

  const failures: string[] = [];
  const checks: string[] = ['platformer gameplay mechanics contract applies'];
  const metadataSnippet = extractGameMetadataSnippet(content)?.text || content;
  const gameplayIndex = metadataSnippet.search(/\bgameplayMechanics\b/i);
  const gameplaySnippet = gameplayIndex >= 0
    ? metadataSnippet.slice(gameplayIndex, Math.min(metadataSnippet.length, gameplayIndex + 7000))
    : '';

  if (!gameplaySnippet) {
    failures.push('platformer 缺少 gameplayMechanics 元数据；请在 __GAME_META__ 中声明并实现 enemies、blocks、abilities、gates、comboChallenge。');
    return { failures, checks };
  }

  checks.push('platformer gameplayMechanics metadata detected');

  for (const field of ['enemies', 'blocks', 'abilities', 'gates', 'comboChallenge']) {
    if (!hasGameplayMechanicsArray(gameplaySnippet, field)) {
      failures.push(`platformer gameplayMechanics 缺少 ${field} 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge，单个机制也要写成数组，不能写成对象 map。`);
    }
  }

  if (!/\benemies\b[\s\S]{0,1800}(?:\bstompable\s*:\s*true|["']stompable["']\s*:\s*true|\bstomp\b|stompableEnemy)/i.test(gameplaySnippet)) {
    failures.push('platformer gameplayMechanics.enemies 缺少 stompable enemy；请添加可踩踏敌人，并让踩踏改变 enemy defeated 状态与玩家 bounce/vy。');
  }

  if (!/\bblocks\b[\s\S]{0,1800}(?:\bbumpableFromBelow\s*:\s*true|["']bumpableFromBelow["']\s*:\s*true|\bbumpable\b|\bquestion\b|questionBlock)/i.test(gameplaySnippet)) {
    failures.push('platformer gameplayMechanics.blocks 缺少 bumpable/question block；请添加可从下方顶起的砖块，并产生 used/broken/reward 状态。');
  }

  if (!/\babilities\b[\s\S]{0,2200}/i.test(gameplaySnippet) || !PLATFORMER_ABILITY_PATTERN.test(gameplaySnippet)) {
    failures.push('platformer gameplayMechanics.abilities 缺少改变规则的技能；至少添加 doubleJump、dash、shield、magnet、groundPound 或 wallJump 之一。');
  }

  if (!/\babilities\b[\s\S]{0,2200}\b(?:effect|unlocksRoute|acquiredFrom)\b/i.test(gameplaySnippet)) {
    failures.push('platformer gameplayMechanics.abilities 缺少 acquiredFrom/effect/unlocksRoute；技能必须说明来源、效果以及它改变哪条路线或交互规则。');
  }

  if (!/\bgates\b[\s\S]{0,1800}\brequiresAbility\b[\s\S]{0,900}\bblocksAccessTo\b/i.test(gameplaySnippet)) {
    failures.push('platformer gameplayMechanics.gates 缺少 requiresAbility 和 blocksAccessTo；至少有一段区域必须通过技能或奖励才能到达或通过。');
  }

  const comboMatch = /\bcomboChallenge\b[\s\S]{0,2200}/i.exec(gameplaySnippet);
  const comboSnippet = comboMatch?.[0] || '';
  if (!/\bjump\b/i.test(comboSnippet) || countComboAxes(comboSnippet) < 2) {
    failures.push('platformer gameplayMechanics.comboChallenge 必须组合 jump，并至少再组合 stomp/enemy、block bump、ability 或 gate route 中的两类。');
  }

  return { failures, checks };
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

async function runRuntimeSmoke(filePath: string, timeoutMs: number): Promise<RuntimeSmokeSummary> {
  let browser: import('playwright').Browser | null = null;
  let chromeProcess: ChildProcess | null = null;
  let profileDir: string | null = null;

  try {
    const { chromium } = await import('playwright');
    const resolution = resolveBrowserProvider();
    let page: import('playwright').Page | null = null;

    if (resolution.provider === 'system-chrome-cdp' && !resolution.missingExecutable && resolution.systemExecutable) {
      try {
        const port = await findAvailablePort();
        profileDir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-runtime-'));
        chromeProcess = spawn(
          resolution.systemExecutable,
          [
            ...buildSystemChromeCdpArgs({
              cdpPort: port,
              profileDir,
              headless: true,
              viewport: { width: 900, height: 700 },
            }),
            'about:blank',
          ],
          { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        await waitForCdpEndpoint(port, chromeProcess, Math.min(timeoutMs, 8000));
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0] || await browser.newContext({
          viewport: { width: 900, height: 700 },
        });
        page = context.pages()[0] || await context.newPage();
        await page.setViewportSize({ width: 900, height: 700 });
      } catch {
        await browser?.close().catch(() => undefined);
        browser = null;
        await stopChromeProcess(chromeProcess).catch(() => undefined);
        chromeProcess = null;
        if (profileDir) {
          await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
          profileDir = null;
        }
      }
    }

    if (!page) {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    }

    await page.goto(pathToFileURL(filePath).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const smokeTimeoutMs = Math.min(timeoutMs, 5000);
    const runtimeProbeScript = `
      (async () => {
        const innerTimeoutMs = ${smokeTimeoutMs};
        const root = window;
        const contract = root.__INTERACTIVE_TEST__ || root.__GAME_TEST__;
        if (!contract || typeof contract.runSmokeTest !== 'function') {
          return { passed: false, failures: ['运行时没有找到 runSmokeTest。'] };
        }
        if (typeof contract.start !== 'function' || typeof contract.snapshot !== 'function') {
          return { passed: false, failures: ['运行时测试合约缺少 start 或 snapshot。'] };
        }

        const checks = [];
        const failures = [];
        const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
        const collectStrings = (value) => {
          if (typeof value === 'string') return [value];
          if (Array.isArray(value)) return value.flatMap(collectStrings);
          if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
          return [];
        };
        const collectControlKeys = (value) => {
          if (!value) return [];
          if (typeof value === 'string') return [value];
          if (Array.isArray(value)) return value.flatMap(collectControlKeys);
          if (typeof value === 'object') {
            const directKeys = Object.keys(value).filter((key) => /^[A-Za-z0-9_+-]+$/.test(key));
            return [
              ...directKeys,
              ...Object.values(value).flatMap(collectControlKeys),
            ];
          }
          return [];
        };
        const contractMeta = contract && typeof contract === 'object' ? contract : {};
        const meta = Object.assign(
          {},
          root.__GAME_META__ || {},
          root.__INTERACTIVE_META__ || {},
          contractMeta
        );
        const controls = collectStrings(meta.controls);
        const keyControls = [...new Set(collectControlKeys(meta.controls).filter((control) => /^[A-Za-z0-9_+-]+$/.test(control)))];
        const controlAliases = {};
        const addControlAlias = (inputKey, alias) => {
          if (typeof inputKey !== 'string' || typeof alias !== 'string') return;
          const key = inputKey.trim();
          const normalizedAlias = alias.trim();
          if (!key || !normalizedAlias) return;
          if (!controlAliases[key]) controlAliases[key] = [];
          if (!controlAliases[key].includes(normalizedAlias)) controlAliases[key].push(normalizedAlias);
        };
        const registerControlAliases = (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          for (const [alias, mappedValue] of Object.entries(value)) {
            addControlAlias(alias, alias);
            for (const key of collectControlKeys(mappedValue)) {
              addControlAlias(key, alias);
            }
          }
        };
        registerControlAliases(meta.controls);
        addControlAlias('ArrowLeft', 'left');
        addControlAlias('ArrowRight', 'right');
        addControlAlias('ArrowUp', 'jump');
        addControlAlias('Space', 'jump');
        addControlAlias(' ', 'jump');
        const reachabilityPlan = (
          Array.isArray(meta.reachability) ? meta.reachability
            : Array.isArray(meta.acceptance) ? meta.acceptance
              : Array.isArray(meta.smokePlan) ? meta.smokePlan
                : Array.isArray(meta.progressPlan) ? meta.progressPlan
                  : Array.isArray(meta.validation) ? meta.validation
                    : []
        );
        const firstArray = (...values) => values.find((value) => Array.isArray(value));
        const authoredUnits = firstArray(meta.levels, meta.segments, meta.scenarios, meta.stages, meta.missions) || [];
        const authoredUnitTargets = authoredUnits.map((unit, index) => {
          if (unit && typeof unit === 'object') {
            if (typeof unit.id === 'string' || typeof unit.id === 'number') return unit.id;
            if (typeof unit.key === 'string' || typeof unit.key === 'number') return unit.key;
            if (typeof unit.name === 'string' || typeof unit.name === 'number') return unit.name;
          }
          return index;
        });
        const qualityPlan = meta.qualityPlan || (!Array.isArray(meta.acceptance) && meta.acceptance && typeof meta.acceptance === 'object' ? meta.acceptance : {});
        const hasReset = typeof contract.reset === 'function';
        const hasStep = typeof contract.step === 'function';
        const numericCountFrom = (value) => {
          if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
          if (Array.isArray(value)) return value.length;
          if (value && typeof value === 'object') {
            const nestedCounts = Object.values(value).map(numericCountFrom).filter((count) => count > 0);
            return nestedCounts.length > 0 ? Math.max(...nestedCounts) : 0;
          }
          return 0;
        };
        const declaredAuthoredCount = Math.max(
          authoredUnits.length,
          numericCountFrom(meta.levelsCovered),
          numericCountFrom(qualityPlan.levelsCovered),
          numericCountFrom(meta.totalLevels),
          numericCountFrom(qualityPlan.totalLevels)
        );
        while (authoredUnitTargets.length < declaredAuthoredCount) {
          authoredUnitTargets.push(authoredUnitTargets.length);
        }
        const listFrom = (value, keyPath = '') => {
          if (!value) return [];
          if (Array.isArray(value)) return value.filter(Boolean).flatMap((item) => listFrom(item, keyPath));
          if (typeof value === 'object') {
            return Object.entries(value).flatMap(([key, childValue]) => {
              const childPath = keyPath ? keyPath + '.' + key : key;
              if (childValue === true) return [childPath];
              if (childValue === false || childValue === null || typeof childValue === 'undefined') return [];
              return listFrom(childValue, childPath);
            });
          }
          if (typeof value === 'boolean') return value ? (keyPath ? [keyPath] : ['true']) : [];
          return [String(value)];
        };
        const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
        const textFrom = (value) => {
          try {
            return JSON.stringify(value || {}).toLowerCase();
          } catch {
            return String(value || '').toLowerCase();
          }
        };
        const anyTextMatches = (value, patterns) => patterns.some((pattern) => pattern.test(textFrom(value)));
        const isNegativeEvidence = (value) => (
          /(?:^|[\s:,[({=;-])(?:false|fail|failed|failure|missing|not|none|no)(?:$|[\s:,\])}.!;=-])|缺少|失败|未通过|没有|不能|无法/i
            .test(String(value || '').toLowerCase())
        );
        const collectEvidenceStrings = (smoke, coverage) => {
          if (!smoke || smoke.passed !== true) return '';
          return [
            ...listFrom(coverage && coverage.mechanics),
            ...listFrom(coverage && coverage.rewards),
            ...listFrom(coverage && coverage.risks),
            ...listFrom(coverage && coverage.stateChanges),
            ...listFrom(coverage && coverage.gameplayMechanics),
            ...listFrom(coverage && coverage.mechanicsEvidence),
            ...listFrom(smoke && smoke.checks),
            ...listFrom(smoke && smoke.observations),
          ].filter((item) => !isNegativeEvidence(item)).join(' | ').toLowerCase();
        };
        const findNumericValue = (value, keyPatterns) => {
          let found;
          const visit = (current, key = '') => {
            if (typeof found === 'number') return;
            if (typeof current === 'number' && keyPatterns.some((pattern) => pattern.test(key))) {
              found = current;
              return;
            }
            if (!current || typeof current !== 'object') return;
            for (const [childKey, childValue] of Object.entries(current)) {
              visit(childValue, childKey);
            }
          };
          visit(value);
          return typeof found === 'number' ? found : 0;
        };
        const countMatchingObjects = (value, predicate) => {
          let count = 0;
          const visit = (current, key = '') => {
            if (!current || typeof current !== 'object') return;
            if (predicate(current, key)) count += 1;
            for (const [childKey, childValue] of Object.entries(current)) {
              visit(childValue, childKey);
            }
          };
          visit(value);
          return count;
        };
        const countDefeatedEnemies = (snapshot) => countMatchingObjects(snapshot, (object, key) => {
          const objectText = textFrom(object);
          const keyText = String(key).toLowerCase();
          const enemyish = /enemy|enemies|stomp/.test(keyText + ' ' + objectText);
          if (!enemyish) return false;
          return object.defeated === true
            || object.stomped === true
            || object.alive === false
            || /defeated|stomped|squashed/.test(String(object.state || object.status || '').toLowerCase());
        });
        const countUsedBlocks = (snapshot) => countMatchingObjects(snapshot, (object, key) => {
          const objectText = textFrom(object);
          const keyText = String(key).toLowerCase();
          const blockish = /block|brick|question/.test(keyText + ' ' + objectText);
          if (!blockish) return false;
          return object.used === true
            || object.broken === true
            || object.bumped === true
            || /used|broken|bumped|empty/.test(String(object.state || object.status || '').toLowerCase());
        });
        const countOpenGates = (snapshot) => countMatchingObjects(snapshot, (object, key) => {
          const objectText = textFrom(object);
          const keyText = String(key).toLowerCase();
          const gateish = /gate|door|route/.test(keyText + ' ' + objectText);
          if (!gateish) return false;
          return object.open === true
            || object.unlocked === true
            || object.reachable === true
            || /open|unlocked|reachable|passed/.test(String(object.state || object.status || '').toLowerCase());
        });
        const snapshotAbilities = (snapshot) => {
          const playerAbilities = readMetric(snapshot, 'player.abilities');
          const directAbilities = readMetric(snapshot, 'abilities');
          return typeof playerAbilities !== 'undefined' ? playerAbilities : directAbilities;
        };
        const validatePlatformerGameplayRuntimeEvidence = (gameplayMechanics, beforeSnapshot, afterSnapshot, smoke, coverage) => {
          if (!isPlainObject(gameplayMechanics)) return;
          const evidence = collectEvidenceStrings(smoke, coverage);
          const hasEvidence = (patterns) => patterns.some((pattern) => pattern.test(evidence));
          const enemyDelta =
            findNumericValue(afterSnapshot, [/enemiesdefeated/i, /defeatedenemies/i, /stompedenemies/i, /^stomps?$/i])
            > findNumericValue(beforeSnapshot, [/enemiesdefeated/i, /defeatedenemies/i, /stompedenemies/i, /^stomps?$/i])
            || countDefeatedEnemies(afterSnapshot) > countDefeatedEnemies(beforeSnapshot)
            || hasEvidence([/stomp/, /enemy[_ -]?defeat/, /defeated[_ -]?enemy/]);
          const bounceEvidence =
            JSON.stringify(readMetric(beforeSnapshot, 'player.vy')) !== JSON.stringify(readMetric(afterSnapshot, 'player.vy'))
            || hasEvidence([/bounce/, /stomp[_ -]?bounce/, /\bvy\b/, /vertical[_ -]?velocity/]);
          if (enemyDelta && bounceEvidence) {
            checks.push('platformer gameplay runtime covered stompable enemy with defeated/bounce evidence');
          } else {
            failures.push('platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。');
          }

          const blockDelta =
            findNumericValue(afterSnapshot, [/blocksbumped/i, /blocksused/i, /blockhits/i, /spawnedrewards/i])
            > findNumericValue(beforeSnapshot, [/blocksbumped/i, /blocksused/i, /blockhits/i, /spawnedrewards/i])
            || countUsedBlocks(afterSnapshot) > countUsedBlocks(beforeSnapshot)
            || hasEvidence([/bump[_ -]?block/, /question[_ -]?block/, /block[_ -]?(used|broken|bumped)/, /spawned[_ -]?reward/]);
          if (blockDelta) {
            checks.push('platformer gameplay runtime covered bumpable block evidence');
          } else {
            failures.push('platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。');
          }

          const beforeAbilities = snapshotAbilities(beforeSnapshot);
          const afterAbilities = snapshotAbilities(afterSnapshot);
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
            JSON.stringify(beforeAbilities) !== JSON.stringify(afterAbilities)
            || abilityEvidence;
          if (abilityChanged && abilityEvidence) {
            checks.push('platformer gameplay runtime covered ability acquisition evidence');
          } else {
            failures.push('platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。');
          }

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
            findNumericValue(afterSnapshot, [/gatesunlocked/i, /routesunlocked/i, /reachabletargets/i])
            > findNumericValue(beforeSnapshot, [/gatesunlocked/i, /routesunlocked/i, /reachabletargets/i])
            || countOpenGates(afterSnapshot) > countOpenGates(beforeSnapshot)
            || gateEvidence;
          if (abilityChanged && abilityEvidence && gateDelta && gateEvidence) {
            checks.push('platformer gameplay runtime covered ability-gated route evidence');
          } else {
            failures.push('platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。');
          }

          const comboRequires = textFrom(gameplayMechanics.comboChallenge);
          const comboText = evidence;
          const comboHasJump = /jump/.test(comboText);
          const comboAxisCount = [
            /stomp|enemy/,
            /block|bump|question/,
            /ability|abilities|double[_ -]?jump|doublejump|dash|shield|magnet|ground[_ -]?pound|groundpound|wall[_ -]?jump|walljump/,
            /gate|route|unlock|reachable/,
          ].filter((pattern) => pattern.test(comboText)).length;
          const comboCovered = /combo|challenge|sequence/.test(comboText) && comboHasJump && comboAxisCount >= 2 && /requires|target/.test(comboRequires);
          if (comboCovered) {
            checks.push('platformer gameplay runtime covered comboChallenge evidence');
          } else {
            failures.push('platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。');
          }
        };
        const executableKeySet = new Set(keyControls);
        const collectActionStrings = (value) => {
          if (typeof value === 'string') return [value];
          if (Array.isArray(value)) return value.flatMap(collectActionStrings);
          if (value && typeof value === 'object') return Object.values(value).flatMap(collectActionStrings);
          return [];
        };
        const parseActionKeys = (action) => {
          const rawCandidates = [];
          if (typeof action.key === 'string') rawCandidates.push(action.key);
          if (typeof action.input === 'string') rawCandidates.push(action.input);
          if (typeof action.control === 'string') rawCandidates.push(action.control);
          if (typeof action.action === 'string') rawCandidates.push(action.action);
          if (typeof action.code === 'string') rawCandidates.push(action.code);
          if (Array.isArray(action.input)) rawCandidates.push(...collectActionStrings(action.input));
          if (Array.isArray(action.keys)) rawCandidates.push(...collectActionStrings(action.keys));
          if (Array.isArray(action.controls)) rawCandidates.push(...collectActionStrings(action.controls));

          const extracted = [];
          for (const candidate of rawCandidates) {
            if (typeof candidate !== 'string') continue;
            const trimmed = candidate.trim();
            if (!trimmed) continue;
            if (executableKeySet.size === 0) {
              if (/^[A-Za-z0-9_+-]+$/.test(trimmed)) extracted.push(trimmed);
              continue;
            }
            if (executableKeySet.has(trimmed)) {
              extracted.push(trimmed);
              continue;
            }
            for (const token of trimmed.split(/[^A-Za-z0-9_+-]+/).filter(Boolean)) {
              if (executableKeySet.has(token)) extracted.push(token);
            }
          }

          return [...new Set(extracted)];
        };
        const actionFrameCount = (action, fallback = 6) => {
          const rawFrames = typeof action.holdFrames === 'number' ? action.holdFrames
            : typeof action.frames === 'number' ? action.frames
              : typeof action.durationFrames === 'number' ? action.durationFrames
                : typeof action.ticks === 'number' ? action.ticks
                  : fallback;
          return Math.max(1, Math.min(600, Math.floor(Number.isFinite(rawFrames) ? rawFrames : fallback)));
        };
        const driveKeys = async (keys, frames) => {
          const inputState = {};
          for (const key of keys) {
            inputState[key] = true;
            for (const alias of controlAliases[key] || []) inputState[alias] = true;
          }

          if (hasStep) {
            for (let frame = 0; frame < frames; frame++) {
              await Promise.resolve(contract.step(inputState, 1));
            }
            await Promise.resolve(contract.step({}, 1));
            return;
          }

          for (let frame = 0; frame < frames; frame++) {
            for (const key of keys) {
              window.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
            }
            if (hasStep) {
              await Promise.resolve(contract.step(inputState, 1));
            } else {
              await sleep(35);
            }
          }

          for (const key of keys) {
            window.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
          }
          await sleep(80);
        };
        const readMetric = (snapshot, key) => {
          if (!snapshot || typeof snapshot !== 'object') return undefined;
          return String(key).replace(/\\[(\\d+)\\]/g, '.$1').split('.').reduce((current, part) => {
            if (!current || typeof current !== 'object') return undefined;
            return current[part];
          }, snapshot);
        };
        const compareMetric = (beforeValue, afterValue, expectation) => {
          if (expectation === 'increase') return typeof beforeValue === 'number' && typeof afterValue === 'number' && afterValue > beforeValue;
          if (expectation === 'decrease') return typeof beforeValue === 'number' && typeof afterValue === 'number' && afterValue < beforeValue;
          if (expectation === 'change') return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
          if (expectation === 'truthy') return Boolean(afterValue);
          if (typeof expectation === 'boolean' || typeof expectation === 'number') return afterValue === expectation;
          if (typeof expectation === 'string') {
            const trimmed = expectation.trim();
            if (!trimmed) return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
            if (trimmed === 'true') return afterValue === true;
            if (trimmed === 'false') return afterValue === false;
            if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return typeof afterValue === 'number' && afterValue === Number(trimmed);
            return afterValue === trimmed;
          }
          return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
        };

        const labelForUnit = (unitIndex, unitTarget) => {
          if (declaredAuthoredCount <= 1) return 'default start state';
          return 'authored unit ' + String(unitTarget ?? unitIndex);
        };
        const reachabilityMetricFailures = [];
        const resetToUnit = async (unitIndex, unitTarget) => {
          if (hasReset) {
            await Promise.resolve(contract.reset(unitTarget));
            return true;
          }
          await Promise.resolve(contract.start());
          return false;
        };
        const timeout = new Promise((resolve) => {
          window.setTimeout(() => {
            resolve({ passed: false, failures: ['runSmokeTest 超过 ' + innerTimeoutMs + 'ms 仍未返回。'] });
          }, innerTimeoutMs);
        });

        try {
          await Promise.resolve(contract.start());
          if (hasStep) {
            checks.push('interactive contract exposes step(inputState, frames)');
          }
          if (hasReset) {
            checks.push('interactive contract exposes reset(levelOrScenario)');
          }
          const tryInputProbe = async (keys) => {
            const before = await Promise.resolve(contract.snapshot());
            await driveKeys(keys, 8);
            const after = await Promise.resolve(contract.snapshot());
            return {
              changed: JSON.stringify(before) !== JSON.stringify(after),
              before,
              after,
            };
          };
          const runReachabilityChecks = async (unitIndex, unitTarget) => {
            const unitLabel = labelForUnit(unitIndex, unitTarget);
            let unitPassed = true;

            if (keyControls.length > 0) {
              let inputChangedState = false;
              const actionCandidates = [];
              for (const step of reachabilityPlan) {
                const keys = parseActionKeys(step);
                if (keys.length > 0) actionCandidates.push(keys);
              }
              for (const key of keyControls) {
                actionCandidates.push([key]);
              }

              for (const keys of actionCandidates) {
                await resetToUnit(unitIndex, unitTarget);
                const probe = await tryInputProbe(keys);
                if (probe.changed) {
                  checks.push('snapshot changed after declared controls for ' + unitLabel + ': ' + keys.join('+'));
                  inputChangedState = true;
                  break;
                }
              }

              if (!inputChangedState) {
                failures.push(unitLabel + ' 的声明输入执行后 snapshot 没有变化，无法证明主对象可操作。');
                unitPassed = false;
              }
            } else {
              failures.push('元数据 controls 没有暴露可派发的输入值。');
              unitPassed = false;
            }

            await resetToUnit(unitIndex, unitTarget);
            if (reachabilityPlan.length === 0) {
              failures.push('元数据没有暴露 reachability/acceptance/progressPlan/validation 数组，无法验证目标或场景是否可推进；__GAME_META__.progress 或 coverage 对象不算可执行验收计划。');
              return false;
            }

            for (const [index, step] of reachabilityPlan.entries()) {
              const keysToPress = parseActionKeys(step);
              const metric = typeof step.metric === 'string' && step.metric.trim() ? step.metric.trim() : 'progress';
              const expectation = Object.prototype.hasOwnProperty.call(step, 'expect')
                ? (typeof step.expect === 'string' ? (step.expect.trim() || 'increase') : step.expect)
                : 'increase';
              const holdFrames = actionFrameCount(step);

              if (keysToPress.length === 0) {
                failures.push('reachability step ' + (index + 1) + ' 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。');
                unitPassed = false;
                continue;
              }

              const beforeStep = await Promise.resolve(contract.snapshot());
              const beforeMetric = readMetric(beforeStep, metric);
              if (typeof beforeMetric === 'undefined') {
                failures.push('reachability step ' + (index + 1) + ' 的 metric "' + metric + '" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。');
                unitPassed = false;
                continue;
              }
              await driveKeys(keysToPress, holdFrames);
              const afterStep = await Promise.resolve(contract.snapshot());
              const afterMetric = readMetric(afterStep, metric);
              if (compareMetric(beforeMetric, afterMetric, expectation)) {
                checks.push(unitLabel + ' passed reachability step ' + (index + 1) + ' for ' + metric);
              } else {
                reachabilityMetricFailures.push({
                  message: unitLabel + ' 的 reachability step ' + (index + 1) + ' 没有让 ' + metric + ' 满足 ' + expectation + '。',
                  unitLabel,
                  stepIndex: index + 1,
                  metric,
                  expectation,
                  input: keysToPress.join('+'),
                  frames: holdFrames,
                  beforeMetric,
                  afterMetric,
                });
                unitPassed = false;
              }
            }

            return unitPassed;
          };

          let authoredUnitsExercised = declaredAuthoredCount <= 1;
          if (declaredAuthoredCount > 1 && hasReset) {
            authoredUnitsExercised = true;
            for (let index = 0; index < authoredUnitTargets.length; index++) {
              const unitPassed = await runReachabilityChecks(index, authoredUnitTargets[index]);
              authoredUnitsExercised = authoredUnitsExercised && unitPassed;
            }
          } else {
            const defaultPathPassed = await runReachabilityChecks(0, authoredUnitTargets[0]);
            authoredUnitsExercised = declaredAuthoredCount <= 1 ? defaultPathPassed : false;
          }

          const beforeSmokeSnapshot = await Promise.resolve(contract.snapshot());
          const smokeResult = await Promise.race([
            Promise.resolve(contract.runSmokeTest({ timeoutMs: innerTimeoutMs })),
            timeout,
          ]);
          const afterSmokeSnapshot = await Promise.resolve(contract.snapshot());
          const smoke = smokeResult && typeof smokeResult === 'object'
            ? smokeResult
            : { passed: false, failures: ['runSmokeTest 没有返回结构化结果。'] };
          if (smoke.passed === true && !Array.isArray(smoke.checks)) {
            failures.push('runSmokeTest.checks 必须是字符串数组，不能返回数字、布尔值或对象计数。');
          }
          if (smoke.passed === true && !Array.isArray(smoke.failures)) {
            failures.push('runSmokeTest.failures 必须是字符串数组；通过时请返回空数组。');
          }
          if (Array.isArray(smoke.checks)) checks.push(...smoke.checks.map(String));
          if (Array.isArray(smoke.observations)) checks.push(...smoke.observations.map(String));
          if (Array.isArray(smoke.failures)) failures.push(...smoke.failures.map(String));
          const coverage = smoke.coverage && typeof smoke.coverage === 'object' ? smoke.coverage : null;
          let stateChangesCovered = [];
          let coverageProvedAuthoredUnits = false;
          if (!coverage) {
            failures.push('runSmokeTest 缺少 coverage，无法证明玩法、奖励/风险或关卡覆盖。');
          } else {
            const coverageValueNamesEvidence = (fieldName, value) => {
              if (typeof value === 'undefined' || value === null) return;
              if (Array.isArray(value) || isPlainObject(value)) return;
              failures.push(
                'runSmokeTest coverage.' + fieldName +
                ' 必须列出已验证的机制名称或布尔证据对象，不能只返回数字、布尔值或 total 计数。'
              );
            };
            coverageValueNamesEvidence('mechanics', coverage.mechanics);
            coverageValueNamesEvidence('rewards', coverage.rewards);
            coverageValueNamesEvidence('risks', coverage.risks);
            coverageValueNamesEvidence('stateChanges', coverage.stateChanges);

            const mechanicsPromised = listFrom(qualityPlan.mechanics || meta.requiredMechanics || meta.mechanics);
            const rewardsPromised = listFrom(qualityPlan.rewards || meta.rewards || meta.powerUps || meta.collectibles);
            const risksPromised = listFrom(qualityPlan.risks || meta.risks || meta.hazards || meta.enemies);
            const mechanicsCovered = listFrom(coverage.mechanics);
            const rewardsCovered = listFrom(coverage.rewards);
            const risksCovered = listFrom(coverage.risks);
            stateChangesCovered = listFrom(coverage.stateChanges);

            if (declaredAuthoredCount > 1) {
              const levelCount = typeof coverage.levelsPassed === 'number'
                ? coverage.levelsPassed
                : Array.isArray(coverage.levelsPassed) ? coverage.levelsPassed.length : 0;
              const totalLevels = typeof coverage.totalLevels === 'number' ? coverage.totalLevels : declaredAuthoredCount;
              if (authoredUnitsExercised) {
                checks.push('reset/step path exercised authored units: ' + authoredUnitTargets.map((target) => String(target)).join(', '));
                coverageProvedAuthoredUnits = true;
              } else if (coverage.allLevelsReachable !== true || totalLevels < declaredAuthoredCount || levelCount < declaredAuthoredCount) {
                const resetHint = hasReset
                  ? ''
                  : ' 请补一个可调用的 reset(levelId/index)，让工程层逐关重置并驱动验证。';
                failures.push('coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=' + declaredAuthoredCount + ', passed=' + levelCount + ', total=' + totalLevels + '。' + resetHint);
              } else {
                checks.push('coverage proved all authored levels reachable');
                coverageProvedAuthoredUnits = true;
              }
            }

            if (mechanicsPromised.length > 0 && mechanicsCovered.length === 0) {
              failures.push('coverage 没有覆盖 qualityPlan 承诺的核心玩法。');
            } else if (mechanicsCovered.length > 0) {
              checks.push('coverage included mechanics: ' + mechanicsCovered.join(', '));
            }

            if (rewardsPromised.length > 0 && rewardsCovered.length === 0) {
              failures.push('coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。');
            } else if (rewardsCovered.length > 0) {
              checks.push('coverage included rewards: ' + rewardsCovered.join(', '));
            }

            if (risksPromised.length > 0 && risksCovered.length === 0) {
              failures.push('coverage 没有覆盖 qualityPlan 承诺的风险、敌人或失败约束。');
            } else if (risksCovered.length > 0) {
              checks.push('coverage included risks: ' + risksCovered.join(', '));
            }

            if (stateChangesCovered.length > 0) {
              checks.push('coverage included state changes: ' + stateChangesCovered.join(', '));
            }

            const subtype = String(meta.subtype || meta.genre || meta.type || '').toLowerCase();
            if (subtype.includes('platformer') && meta.gameplayMechanics && typeof meta.gameplayMechanics === 'object') {
              validatePlatformerGameplayRuntimeEvidence(
                meta.gameplayMechanics,
                beforeSmokeSnapshot,
                afterSmokeSnapshot,
                smoke,
                coverage
              );
            }
          }
          const metricCoveredBySmoke = (metric) => {
            const normalized = String(metric || '').trim().toLowerCase();
            if (!normalized) return false;
            const rootMetric = normalized.split('.')[0];
            return stateChangesCovered.some((entry) => {
              const covered = String(entry || '').trim().toLowerCase();
              if (!covered) return false;
              if (covered === normalized || covered === rootMetric) return true;
              if (normalized.startsWith(covered + '.') || covered.startsWith(normalized + '.')) return true;
              if (rootMetric === 'level' && (covered === 'levels' || covered === 'level_progression' || covered === 'progression')) return true;
              if (rootMetric === 'mode' && (covered === 'state' || covered === 'status')) return true;
              if (rootMetric === 'abilities' && (covered === 'ability' || covered === 'powerups' || covered === 'power-ups' || covered === 'power_ups')) return true;
              return false;
            });
          };
          for (const failure of reachabilityMetricFailures) {
            if (smoke.passed === true && metricCoveredBySmoke(failure.metric) && (declaredAuthoredCount <= 1 || coverageProvedAuthoredUnits)) {
              checks.push('runSmokeTest coverage covered reachability metric ' + failure.metric + ' after external probe missed long-path input for ' + failure.unitLabel);
              continue;
            }
            failures.push(
              failure.message +
              ' input=' + failure.input +
              ', frames=' + failure.frames +
              ', before=' + JSON.stringify(failure.beforeMetric) +
              ', after=' + JSON.stringify(failure.afterMetric) +
              '。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 ' + failure.metric + '。'
            );
          }
          if (smoke.passed !== true) failures.push('runSmokeTest 未通过。');
          return { passed: failures.length === 0, checks, failures };
        } catch (error) {
          return {
            passed: false,
            failures: ['runSmokeTest 抛出异常: ' + (error instanceof Error ? error.message : String(error))],
          };
        }
      })()
    `;
    const rawResult = await page.evaluate(runtimeProbeScript);

    const smoke = normalizeRuntimeSmokeResult(rawResult);
    if (smoke.passed) {
      smoke.checks.unshift('runtime smoke passed via interactive test contract');
    }
    return smoke;
  } catch (error) {
    return {
      attempted: true,
      passed: false,
      failures: [`无法运行交互 smoke 验收: ${error instanceof Error ? error.message : String(error)}`],
      checks: [],
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChromeProcess(chromeProcess).catch(() => undefined);
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function waitForCdpEndpoint(port: number, chromeProcess: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
      throw new Error(`System Chrome exited before CDP became ready (code=${chromeProcess.exitCode ?? 'null'}, signal=${chromeProcess.signalCode ?? 'null'})`);
    }

    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error');
  throw new Error(`Timed out waiting for Chrome CDP endpoint on port ${port}: ${message}`);
}

async function stopChromeProcess(chromeProcess: ChildProcess | null): Promise<void> {
  if (!chromeProcess || chromeProcess.killed || chromeProcess.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (chromeProcess.exitCode === null && !chromeProcess.killed) {
        chromeProcess.kill('SIGKILL');
      }
      resolve();
    }, 2000);

    chromeProcess.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    chromeProcess.kill('SIGTERM');
  });
}

async function runBrowserVisualSmoke(
  filePath: string,
  timeoutMs: number,
): Promise<BrowserVisualSmokeSummary> {
  const resolution = resolveBrowserProvider();
  if (resolution.provider === 'system-chrome-cdp' && (resolution.missingExecutable || !resolution.systemExecutable)) {
    return {
      attempted: false,
      skipped: true,
      passed: true,
      failures: [],
      checks: [
        `browser visual smoke skipped: ${resolution.recommendedAction || 'System Chrome executable is missing.'}`,
      ],
    };
  }

  const checks: string[] = [];
  const failures: string[] = [];
  const viewportDiagnostics: NonNullable<BrowserVisualSmokeDiagnostics['viewports']> = [];
  let latestTitle = '';
  let latestBodyTextLength = 0;
  let latestVisibleElements = 0;
  let metaPresent = false;
  let testPresent = false;
  let totalCanvasCount = 0;
  let totalNonblankCanvasCount = 0;
  let browser: import('playwright').Browser | null = null;
  let chromeProcess: ChildProcess | null = null;
  let profileDir: string | null = null;
  let stderr = '';

  try {
    const { chromium } = await import('playwright');
    const startedAt = Date.now();
    const remaining = () => Math.max(1200, timeoutMs - (Date.now() - startedAt));
    let page: import('playwright').Page;

    if (resolution.provider === 'system-chrome-cdp') {
      const port = await findAvailablePort();
      const visualProfileDir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-visual-'));
      profileDir = visualProfileDir;
      const executable = resolution.systemExecutable;
      if (!executable) {
        throw new Error(resolution.recommendedAction || 'System Chrome executable is missing.');
      }
      const chromeArgs = [
        ...buildSystemChromeCdpArgs({
          cdpPort: port,
          profileDir: visualProfileDir,
          headless: true,
          viewport: { width: 1280, height: 720 },
        }),
        pathToFileURL(filePath).href,
      ];

      const spawnedChrome = spawn(executable, chromeArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      chromeProcess = spawnedChrome;
      spawnedChrome.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 12000) stderr = stderr.slice(-12000);
      });

      await waitForCdpEndpoint(port, spawnedChrome, Math.min(remaining(), 8000));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0] || await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      page = context.pages()[0] || await context.newPage();
    } else {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      page = await context.newPage();
    }

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    for (const viewport of BROWSER_VISUAL_SMOKE_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(pathToFileURL(filePath).href, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      await page.waitForTimeout(350);

      const probe = await page.evaluate((viewportName) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const documentElement = document.documentElement;
        const body = document.body;
        const canvases = [...document.querySelectorAll('canvas')].map((canvas) => {
          const rect = canvas.getBoundingClientRect();
          const visibleWidth = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
          const visibleArea = visibleWidth * visibleHeight;
          const area = Math.max(0, rect.width * rect.height);
          let coloredPixels = 0;
          let sampledPixels = 0;
          let sampleError: string | null = null;

          try {
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context && canvas.width > 0 && canvas.height > 0) {
              const columns = Math.min(10, Math.max(1, Math.floor(canvas.width / 40)));
              const rows = Math.min(10, Math.max(1, Math.floor(canvas.height / 40)));
              for (let row = 0; row < rows; row += 1) {
                for (let column = 0; column < columns; column += 1) {
                  const x = Math.min(canvas.width - 1, Math.floor((column + 0.5) * canvas.width / columns));
                  const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / rows));
                  const pixel = context.getImageData(x, y, 1, 1).data;
                  sampledPixels += 1;
                  if (pixel[3] > 8 && pixel[0] + pixel[1] + pixel[2] > 28) {
                    coloredPixels += 1;
                  }
                }
              }
            }
          } catch (error) {
            sampleError = error instanceof Error ? error.message : String(error);
          }

          return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            visibleRatio: area > 0 ? visibleArea / area : 0,
            internalWidth: canvas.width,
            internalHeight: canvas.height,
            sampledPixels,
            coloredPixels,
            sampleError,
          };
        });
        const visibleElements = [...document.body.querySelectorAll('*')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 4
              && rect.height > 4
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= viewport.height
              && rect.left <= viewport.width;
          })
          .length;
        const metadataWindow = window as Window & {
          __GAME_META__?: unknown;
          __INTERACTIVE_META__?: unknown;
          __GAME_TEST__?: unknown;
          __INTERACTIVE_TEST__?: unknown;
        };

        return {
          viewportName,
          viewport,
          title: document.title,
          bodyTextLength: body?.innerText?.trim().length || 0,
          metaPresent: Boolean(metadataWindow.__GAME_META__ || metadataWindow.__INTERACTIVE_META__),
          testPresent: Boolean(metadataWindow.__GAME_TEST__ || metadataWindow.__INTERACTIVE_TEST__),
          documentWidth: documentElement.scrollWidth,
          documentHeight: documentElement.scrollHeight,
          horizontalOverflow: documentElement.scrollWidth > viewport.width + 4,
          canvases,
          visibleElements,
        };
      }, viewport.name);

      const canvasCount = probe.canvases.length;
      const visibleCanvasCount = probe.canvases.filter((canvas) =>
        canvas.width >= 16
        && canvas.height >= 16
        && canvas.visibleRatio >= 0.82,
      ).length;
      const sampledCanvases = probe.canvases.filter((canvas) => canvas.sampledPixels > 0);
      const coloredCanvases = sampledCanvases.filter((canvas) => canvas.coloredPixels > 0);
      const horizontallyClippedCanvas = probe.canvases.some((canvas) =>
        canvas.left < -4 || canvas.right > probe.viewport.width + 4,
      );

      latestTitle = probe.title || latestTitle;
      latestBodyTextLength = probe.bodyTextLength;
      latestVisibleElements = probe.visibleElements;
      metaPresent = metaPresent || probe.metaPresent;
      testPresent = testPresent || probe.testPresent;
      totalCanvasCount = Math.max(totalCanvasCount, canvasCount);
      totalNonblankCanvasCount = Math.max(totalNonblankCanvasCount, coloredCanvases.length);
      viewportDiagnostics.push({
        name: viewport.name,
        width: probe.viewport.width,
        height: probe.viewport.height,
        canvasCount,
        nonblankCanvasCount: coloredCanvases.length,
        visibleElements: probe.visibleElements,
        horizontalOverflow: probe.horizontalOverflow,
      });

      if (canvasCount > 0 && visibleCanvasCount === 0) {
        failures.push(`${viewport.name} visual smoke found canvas elements but none are visibly framed in the viewport.`);
      } else if (canvasCount > 0) {
        checks.push(`${viewport.name} visual smoke framed ${visibleCanvasCount}/${canvasCount} canvas element(s)`);
      }

      if (sampledCanvases.length > 0 && coloredCanvases.length === 0) {
        failures.push(`${viewport.name} visual smoke sampled canvas pixels but found no nonblank rendered content.`);
      } else if (coloredCanvases.length > 0) {
        checks.push(`${viewport.name} visual smoke found nonblank canvas pixels`);
      }

      if (canvasCount === 0 && probe.bodyTextLength === 0 && probe.visibleElements < 2) {
        failures.push(`${viewport.name} visual smoke found no canvas and too little visible DOM content.`);
      } else if (canvasCount === 0) {
        checks.push(`${viewport.name} visual smoke found visible DOM content`);
      }

      if (probe.horizontalOverflow && horizontallyClippedCanvas) {
        failures.push(`${viewport.name} visual smoke detected horizontal canvas overflow; the game is likely cropped in this viewport.`);
      } else {
        checks.push(`${viewport.name} visual smoke detected no horizontal canvas cropping`);
      }
    }

    if (pageErrors.length > 0) {
      failures.push(`browser visual smoke saw runtime page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    }
    if (consoleErrors.length > 0) {
      failures.push(`browser visual smoke saw console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    if (failures.length === 0) {
      checks.unshift(
        resolution.provider === 'playwright-bundled'
          ? 'browser visual smoke passed via Playwright bundled Chromium'
          : 'browser visual smoke passed via system Chrome CDP',
      );
    }

    return {
      attempted: true,
      passed: failures.length === 0,
      failures,
      checks,
      diagnostics: {
        title: latestTitle,
        metaPresent,
        testPresent,
        canvasCount: totalCanvasCount,
        nonblankCanvasCount: totalNonblankCanvasCount,
        visibleElements: latestVisibleElements,
        bodyTextLength: latestBodyTextLength,
        consoleErrors: consoleErrors.slice(0, 5),
        pageErrors: pageErrors.slice(0, 5),
        viewports: viewportDiagnostics,
      },
    };
  } catch (error) {
    return {
      attempted: true,
      passed: false,
      failures: [
        `无法运行 browser visual smoke: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr.slice(-1200)}` : ''}`,
      ],
      checks,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChromeProcess(chromeProcess).catch(() => undefined);
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
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
    failures.push(`大型固定 canvas${dimensions ? ` (${dimensions})` : ''} 缺少响应式 CSS；窄窗口会裁切游戏画面。请保留内部分辨率，但给 canvas 或 wrapper 加 max-width/max-height/aspect-ratio/height:auto 等缩放约束。`);
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
      failures.push('发现 progress/coverage 说明，但缺少 reachability/acceptance/progressPlan/validation 元数据；__GAME_META__.progress 或 coverage 对象不算可执行验收计划。请添加 progressPlan 或 reachability 数组，每一步包含 input、frames、metric 和 expect。');
    } else {
      failures.push('缺少 reachability/acceptance/progressPlan/validation 元数据；工程层无法验证目标、场景或关卡能被推进。');
    }
  } else {
    checks.push('reachability/progress metadata detected');
  }

  if (!META_QUALITY_PATTERNS.some((pattern) => pattern.test(content))) {
    failures.push('缺少 qualityPlan/acceptance 级别的玩法承诺元数据；工程层无法判断角色可辨识、奖励/风险是否真实存在。');
  } else {
    checks.push('quality/acceptance metadata detected');
  }

  const platformerGameplayMechanics = validatePlatformerGameplayMechanics(content, filePath);
  checks.push(...platformerGameplayMechanics.checks);
  failures.push(...platformerGameplayMechanics.failures);

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
    failures.push('交互测试合约没有形成可平衡解析的对象字面量；请修复 window.__INTERACTIVE_TEST__ / window.__GAME_TEST__ 的结构。');
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
