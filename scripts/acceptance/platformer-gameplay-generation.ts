#!/usr/bin/env npx tsx

import { config as loadDotenv } from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { StandaloneAgentAdapter } from '../../src/main/testing/agentAdapter.ts';
import { validateGameArtifact } from '../../src/main/agent/runtime/gameArtifactValidator.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');

loadDotenv({ path: path.join(projectRoot, '.env') });

const PROVIDER_KEY_CANDIDATES: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  groq: ['GROQ_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['KIMI_K25_API_KEY', 'MOONSHOT_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
};

type ValidationSummary = {
  artifactPath: string;
  passed: boolean;
  failures: string[];
  runtimePassed?: boolean;
  runtimeFailures?: string[];
  runtimeChecks?: string[];
  browserPassed?: boolean;
  browserFailures?: string[];
  browserChecks?: string[];
};

type AcceptanceOutput = {
  mode: 'validate-only' | 'generate-and-validate';
  provider?: string;
  model?: string;
  generation?: string;
  generationResult: Awaited<ReturnType<typeof runAgentGeneration>> | null;
  generationError?: string;
  validation: ValidationSummary;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

function usage(): void {
  console.log(`Platformer gameplay generation acceptance

Usage:
  npm run acceptance:platformer-gameplay-generation -- [options]

Options:
  --artifact <path>      Target HTML path. Default: games/generated-platformer-regression.html
  --validate-only        Do not call a model; validate an existing artifact.
  --provider <id>        Model provider. Default: PLATFORMER_GAMEPLAY_PROVIDER or openrouter.
  --model <id>           Model id. Default: PLATFORMER_GAMEPLAY_MODEL or google/gemini-3-flash-preview.
  --generation <id>      Agent generation. Default: gen8.
  --generation-timeout <ms>
                       Max time to wait for agent generation. Default: 120000.
  --timeout <ms>         Runtime smoke timeout. Default: 10000.
  --report [path]        Write a Markdown evidence report. If no path is provided, use <artifact>.validation.md.
  --json                 Print JSON summary only.
  --help                 Show this help.

What it validates:
  - a real agent can generate a single-file platformer artifact at the target path
  - the artifact passes static Game Artifact Contract checks
  - browser visual smoke passes on desktop and mobile viewports
  - runtime smoke proves stomp enemy, bump block, ability acquisition, gated route unlock, and comboChallenge evidence`);
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function apiKeyForProvider(provider: string): string | undefined {
  const candidates = PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`];
  for (const candidate of candidates) {
    const value = envValue(candidate);
    if (value) return value;
  }
  return undefined;
}

function resolveArtifactPath(rawPath: string | undefined): string {
  const candidate = rawPath || 'games/generated-platformer-regression.html';
  return path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
}

function resolveReportPath(artifactPath: string, rawPath: string | undefined): string {
  const candidate = rawPath || artifactPath.replace(/\.html?$/i, '.validation.md');
  return path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
}

function buildPrompt(artifactPath: string): string {
  return [
    `Create a complete single-file browser platformer game at this exact path: ${artifactPath}`,
    '',
    'Hard requirements:',
    '- Write the HTML file directly. Do not answer with only prose.',
    '- Include window.__GAME_META__ with subtype "platformer", controls, levels, qualityPlan, progressPlan, browserVisualSmoke, and gameplayMechanics.',
    '- gameplayMechanics must include enemies, blocks, abilities, gates, and comboChallenge as arrays. Do not write enemies/blocks/abilities/gates/comboChallenge as object maps.',
    '- Use this metadata shape: gameplayMechanics: { enemies: [{ id, type, stompable, patrol, defeatReward }], blocks: [{ id, type, bumpableFromBelow, reward, usedState }], abilities: [{ id, type, acquiredFrom, effect, unlocksRoute }], gates: [{ id, requiresAbility, blocksAccessTo }], comboChallenge: [{ id, requires, target }] }.',
    '- Implement a stompable enemy, a bumpable/question block, a route-changing ability such as doubleJump, an ability-gated route, and one combo challenge combining jump plus at least two of enemy/block/ability/gate play.',
    '- Include window.__GAME_TEST__ with start(), reset(levelOrScenario?), snapshot(), step(inputState, frames?), and runSmokeTest().',
    '- step() and the playable loop must share the same live game state and collision logic.',
    '- runSmokeTest() must use before/after snapshot evidence from real step() inputs. It must prove stomp enemy, bump block, gain ability, unlock gate/route, and comboChallenge.',
    '- coverage.mechanics, coverage.rewards, coverage.risks, and coverage.stateChanges must be named arrays or boolean evidence maps, not numbers.',
    '- Do not use input: "none" in progressPlan or reachability.',
    '- Keep the canvas responsive and visibly nonblank on desktop and mobile browser smoke.',
  ].join('\n');
}

async function runAgentGeneration(options: {
  artifactPath: string;
  provider: string;
  model: string;
  apiKey: string;
  generation: string;
}): Promise<{ responses: string[]; toolCount: number; errors: string[] }> {
  await fs.mkdir(path.dirname(options.artifactPath), { recursive: true });
  await fs.rm(options.artifactPath, { force: true });

  const agent = new StandaloneAgentAdapter({
    workingDirectory: projectRoot,
    generation: options.generation,
    modelConfig: {
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
    },
    toolMode: 'deferred',
  });

  const result = await agent.sendMessage(buildPrompt(options.artifactPath));
  await agent.finalizeSession();
  return {
    responses: result.responses,
    toolCount: result.toolExecutions.length,
    errors: result.errors,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function validateArtifact(artifactPath: string, timeoutMs: number): Promise<ValidationSummary> {
  const validation = await validateGameArtifact(artifactPath, {
    runRuntimeSmoke: true,
    runtimeSmokeTimeoutMs: timeoutMs,
    runBrowserVisualSmoke: true,
    browserVisualSmokeTimeoutMs: Math.max(timeoutMs, 10000),
  });

  return {
    artifactPath,
    passed: validation.passed,
    failures: validation.failures,
    runtimePassed: validation.runtimeSmoke?.passed,
    runtimeFailures: validation.runtimeSmoke?.failures,
    runtimeChecks: validation.runtimeSmoke?.checks,
    browserPassed: validation.browserVisualSmoke?.passed,
    browserFailures: validation.browserVisualSmoke?.failures,
    browserChecks: validation.browserVisualSmoke?.checks,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatList(items: string[] | undefined, empty = 'none'): string {
  if (!items || items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function formatGenerationResult(result: AcceptanceOutput['generationResult'], error: string | undefined): string {
  if (!result && !error) return '- N/A';
  const rows = [
    `- toolCount: ${result?.toolCount ?? 'N/A'}`,
    `- responseCount: ${result?.responses.length ?? 'N/A'}`,
    `- errorCount: ${result?.errors.length ?? (error ? 1 : 0)}`,
  ];
  if (error) rows.push(`- generationError: ${error}`);
  if (result?.errors.length) {
    rows.push('', 'Generation errors:', formatList(result.errors));
  }
  return rows.join('\n');
}

async function writeMarkdownReport(reportPath: string, output: AcceptanceOutput): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const validation = output.validation;
  const body = [
    '# Platformer Gameplay Acceptance Report',
    '',
    `- startedAt: ${output.startedAt}`,
    `- finishedAt: ${output.finishedAt}`,
    `- durationMs: ${output.durationMs}`,
    `- mode: ${output.mode}`,
    `- artifactPath: ${validation.artifactPath}`,
    `- provider: ${output.provider ?? 'N/A'}`,
    `- model: ${output.model ?? 'N/A'}`,
    `- generation: ${output.generation ?? 'N/A'}`,
    `- passed: ${validation.passed}`,
    `- runtimePassed: ${validation.runtimePassed ?? 'N/A'}`,
    `- browserPassed: ${validation.browserPassed ?? 'N/A'}`,
    '',
    '## Generation',
    '',
    formatGenerationResult(output.generationResult, output.generationError),
    '',
    '## Validation Failures',
    '',
    formatList(validation.failures),
    '',
    '## Runtime Smoke',
    '',
    `- passed: ${validation.runtimePassed ?? 'N/A'}`,
    '',
    'Runtime failures:',
    '',
    formatList(validation.runtimeFailures),
    '',
    'Runtime checks:',
    '',
    formatList(validation.runtimeChecks),
    '',
    '## Browser Visual Smoke',
    '',
    `- passed: ${validation.browserPassed ?? 'N/A'}`,
    '',
    'Browser checks:',
    '',
    formatList(validation.browserChecks),
    '',
    'Browser failures:',
    '',
    formatList(validation.browserFailures),
    '',
  ].join('\n');
  await fs.writeFile(reportPath, body, 'utf-8');
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const artifactPath = resolveArtifactPath(getStringOption(args, 'artifact'));
  const reportPath = hasFlag(args, 'report')
    ? resolveReportPath(artifactPath, getStringOption(args, 'report'))
    : null;
  const validateOnly = hasFlag(args, 'validate-only');
  const jsonOnly = hasFlag(args, 'json');
  const provider = getStringOption(args, 'provider') || envValue('PLATFORMER_GAMEPLAY_PROVIDER') || 'openrouter';
  const model = getStringOption(args, 'model') || envValue('PLATFORMER_GAMEPLAY_MODEL') || envValue('OPENROUTER_CHAT_MODEL') || 'google/gemini-3-flash-preview';
  const generation = getStringOption(args, 'generation') || envValue('PLATFORMER_GAMEPLAY_GENERATION') || 'gen8';
  const timeoutMs = getNumberOption(args, 'timeout') || 10000;
  const generationTimeoutMs = getNumberOption(args, 'generation-timeout')
    || Number(envValue('PLATFORMER_GAMEPLAY_GENERATION_TIMEOUT_MS') || 0)
    || 120000;

  let generationResult: Awaited<ReturnType<typeof runAgentGeneration>> | null = null;
  let generationError: string | undefined;

  if (!validateOnly) {
    const apiKey = apiKeyForProvider(provider);
    if (!apiKey) {
      throw new Error(`Missing API key for provider ${provider}. Set one of ${(PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`]).join(', ')} or run with --validate-only.`);
    }
    try {
      generationResult = await withTimeout(
        runAgentGeneration({ artifactPath, provider, model, apiKey, generation }),
        generationTimeoutMs,
        `Agent generation timed out after ${generationTimeoutMs}ms`,
      );
      if (generationResult.errors.length > 0) {
        generationError = `Agent generation reported errors: ${generationResult.errors.join('; ')}`;
      }
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
    }
  }

  const artifactAlreadyExists = await fileExists(artifactPath);
  const summary = artifactAlreadyExists
    ? validateArtifact(artifactPath, timeoutMs)
    : {
        artifactPath,
        passed: false,
        failures: [
          generationError
            ? `Artifact was not written; generation failed: ${generationError}`
            : 'Artifact was not written.',
        ],
      };
  const validationSummary = await summary;
  const finishedAtMs = Date.now();
  const output: AcceptanceOutput = {
    mode: validateOnly ? 'validate-only' : 'generate-and-validate',
    provider: validateOnly ? undefined : provider,
    model: validateOnly ? undefined : model,
    generation: validateOnly ? undefined : generation,
    generationResult,
    generationError,
    validation: validationSummary,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
  };

  if (reportPath) {
    await writeMarkdownReport(reportPath, output);
  }

  if (jsonOnly) {
    printJson(output);
  } else {
    printKeyValue('Platformer Gameplay Acceptance', [
      ['mode', output.mode],
      ['artifactPath', artifactPath],
      ['provider', output.provider],
      ['model', output.model],
      ['generation', output.generation],
      ['agentToolCount', generationResult?.toolCount],
      ['generationError', generationError],
      ['reportPath', reportPath],
      ['passed', validationSummary.passed],
      ['runtimePassed', validationSummary.runtimePassed],
      ['browserPassed', validationSummary.browserPassed],
    ]);
    if (!validationSummary.passed) {
      console.error('\nFailures:');
      for (const failure of validationSummary.failures) console.error(`- ${failure}`);
    }
  }

  if (generationError || !validationSummary.passed) {
    process.exit(1);
  }
}

main().catch(finishWithError);
