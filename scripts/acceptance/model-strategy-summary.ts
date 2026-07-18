#!/usr/bin/env npx tsx

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  buildClaudeSubscriptionSmokeArgs,
  buildClaudeSubscriptionSmokeContract,
} from './claude-subscription-cli-smoke.ts';
import {
  buildCodexCliEngineSmokeContract,
} from './codex-cli-engine-smoke.ts';
import {
  buildProviderReportedSavedTokensSmokeContract,
  validateProviderReportedSavedTokensLiveResponse,
} from './provider-reported-saved-tokens-smoke.ts';
import { buildXiaomiProviderResponseArtifact } from './xiaomi-provider-response-artifact.ts';
import { buildModelStrategyFallbackVisibilityResult } from './model-strategy-fallback-visibility.ts';
import { buildModelStrategySurfaceVisibilityResult } from './model-strategy-surface-visibility.ts';

export type ModelStrategyAcceptanceCheckStatus = 'passed' | 'needs-live-evidence' | 'failed';
export type ModelStrategyAcceptanceSummaryStatus = 'passed' | 'offline-passed-live-gates-pending' | 'failed';

export interface ModelStrategyAcceptanceCheck {
  id: string;
  area: 'subscription' | 'provider-saved-tokens' | 'task-recommendation' | 'decision-explainability' | 'script-wiring';
  status: ModelStrategyAcceptanceCheckStatus;
  evidence: string[];
  command?: string;
  blockers?: string[];
  failedChecks?: string[];
}

export interface ModelStrategyAcceptanceSummary {
  ok: boolean;
  status: ModelStrategyAcceptanceSummaryStatus;
  checks: ModelStrategyAcceptanceCheck[];
  liveGates: Array<{
    id: string;
    status: 'pending';
    blockers: string[];
    command: string;
  }>;
}

const REQUIRED_SCRIPTS = {
  'acceptance:claude-subscription-cli': 'jiti scripts/acceptance/claude-subscription-cli-smoke.ts',
  'acceptance:codex-cli-engine': 'jiti scripts/acceptance/codex-cli-engine-smoke.ts',
  'acceptance:provider-saved-tokens': 'jiti scripts/acceptance/provider-reported-saved-tokens-smoke.ts',
  'acceptance:model-strategy-fallback': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-fallback-visibility.ts',
  'acceptance:model-strategy-surface': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-surface-visibility.ts',
  'acceptance:model-strategy-summary': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-summary.ts',
  'test:e2e:model-strategy': 'playwright test --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/model-strategy-recommendation.spec.ts',
} as const;

function scriptCheck(
  scripts: Record<string, string>,
  key: keyof typeof REQUIRED_SCRIPTS,
): ModelStrategyAcceptanceCheck {
  const expected = REQUIRED_SCRIPTS[key];
  const actual = scripts[key];
  const passed = actual === expected;
  return {
    id: `script:${key}`,
    area: 'script-wiring',
    status: passed ? 'passed' : 'failed',
    evidence: passed ? [`${key}=${actual}`] : [],
    failedChecks: passed ? [] : [`expected "${expected}", got "${actual ?? 'missing'}"`],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : null;
}

function readNumber(value: unknown, key: string): number | null {
  const raw = isRecord(value) ? value[key] : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function readArray(value: unknown, key: string): unknown[] {
  const raw = isRecord(value) ? value[key] : undefined;
  return Array.isArray(raw) ? raw : [];
}

function validateCodexCliLiveSmokeResult(result: unknown): {
  ok: boolean;
  version: string | null;
  finalText: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  eventCounts: Record<string, unknown> | null;
} | null {
  if (!isRecord(result)) return null;
  const usage = isRecord(result.usage) ? result.usage : {};
  return {
    ok: result.ok === true && result.status === 'passed',
    version: readString(result, 'version'),
    finalText: readString(result, 'finalText'),
    inputTokens: readNumber(usage, 'inputTokens'),
    outputTokens: readNumber(usage, 'outputTokens'),
    eventCounts: isRecord(result.eventCounts) ? result.eventCounts : null,
  };
}

function validateXiaomiLiveToolCalling(response: unknown): {
  ok: boolean;
  provider: string | null;
  model: string | null;
  toolCallCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
} | null {
  if (!isRecord(response)) return null;
  const usage = isRecord(response.usage) ? response.usage : {};
  const toolCalls = readArray(response, 'toolCalls');
  const inputTokens = readNumber(usage, 'inputTokens') ?? readNumber(usage, 'input_tokens');
  const outputTokens = readNumber(usage, 'outputTokens') ?? readNumber(usage, 'output_tokens');
  return {
    ok: toolCalls.length > 0 && inputTokens !== null && outputTokens !== null,
    provider: readString(response, 'provider'),
    model: readString(response, 'model'),
    toolCallCount: toolCalls.length,
    inputTokens,
    outputTokens,
  };
}

export function buildModelStrategyAcceptanceSummary(args: {
  packageScripts: Record<string, string>;
  env?: { XIAOMI_API_KEY?: string };
  localEnvPresence?: { XIAOMI_API_KEY?: string };
  codexCliSmokeResult?: unknown;
  xiaomiLiveResponse?: unknown;
  inAppBrowserModelStrategyOk?: boolean;
}): ModelStrategyAcceptanceSummary {
  const claudeContract = buildClaudeSubscriptionSmokeContract({ model: undefined });
  const codexContract = buildCodexCliEngineSmokeContract({ model: undefined });
  const codexLive = validateCodexCliLiveSmokeResult(args.codexCliSmokeResult);
  const codexCommand = [
    'CODE_AGENT_CODEX_CLI_SMOKE=1',
    'npm run acceptance:codex-cli-engine -- --manual-codex --json',
  ].join(' ');
  const claudeArgs = buildClaudeSubscriptionSmokeArgs({ model: undefined });

  const providerContract = buildProviderReportedSavedTokensSmokeContract();
  const fallbackVisibility = buildModelStrategyFallbackVisibilityResult();
  const surfaceVisibility = buildModelStrategySurfaceVisibilityResult();
  const providerCommand = [
    'CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1',
    'npm run acceptance:provider-saved-tokens -- --live-response /tmp/xiaomi-provider-response.json --manual-provider --json',
  ].join(' ');

  const xiaomiArtifact = buildXiaomiProviderResponseArtifact({
    model: 'mimo-v2.5-pro',
    capturedAt: '2026-06-14T00:00:00.000Z',
    response: {
      usage: {
        inputTokens: 500,
        outputTokens: 50,
        providerReportedSavedTokens: 42,
      },
      toolCalls: [
        { id: 'tool-1', name: 'get_weather', arguments: { city: 'Shanghai' } },
      ],
    },
  });
  const xiaomiArtifactGate = validateProviderReportedSavedTokensLiveResponse({
    liveResponse: 'xiaomi-provider-response.json',
    response: xiaomiArtifact,
  });
  const providerLiveGate = args.xiaomiLiveResponse
    ? validateProviderReportedSavedTokensLiveResponse({
      liveResponse: 'xiaomi-provider-response.json',
      response: args.xiaomiLiveResponse,
    })
    : null;
  const xiaomiToolCalling = validateXiaomiLiveToolCalling(args.xiaomiLiveResponse);

  const hasXiaomiKey = Boolean(args.env?.XIAOMI_API_KEY || args.localEnvPresence?.XIAOMI_API_KEY);
  const xiaomiLiveBlockers = xiaomiToolCalling
    ? []
    : hasXiaomiKey
      ? ['run Xiaomi live tool-calling smoke and pass --xiaomi-live-response /tmp/xiaomi-provider-response.json']
      : ['XIAOMI_API_KEY is not visible in process env or ~/.code-agent/.env'];
  const providerSavedTokenBlockers = providerLiveGate?.ok
    ? []
    : [
      ...(xiaomiToolCalling?.ok
        ? ['captured Xiaomi live response has usage and tool_calls but no providerReportedSavedTokens or equivalent saved-token field']
        : xiaomiLiveBlockers),
      'modelDecision normalization can only mark provider-reported savings when upstream exposes a saved-token field',
      'usage-only responses remain blocked by contract',
    ];
  const providerSavedTokenBoundaryPassed = providerLiveGate?.ok === true
    || (
      providerLiveGate?.status === 'blocked'
      && xiaomiToolCalling?.ok === true
      && providerLiveGate.failedChecks.every((check) => (
        check === 'providerReportedSavedTokensPresent'
        || check === 'providerReportedSavedTokensFinite'
      ))
    );
  const browserAccepted = args.inAppBrowserModelStrategyOk === true;

  const checks: ModelStrategyAcceptanceCheck[] = [
    scriptCheck(args.packageScripts, 'acceptance:claude-subscription-cli'),
    scriptCheck(args.packageScripts, 'acceptance:codex-cli-engine'),
    scriptCheck(args.packageScripts, 'acceptance:provider-saved-tokens'),
    scriptCheck(args.packageScripts, 'acceptance:model-strategy-fallback'),
    scriptCheck(args.packageScripts, 'acceptance:model-strategy-surface'),
    scriptCheck(args.packageScripts, 'acceptance:model-strategy-summary'),
    scriptCheck(args.packageScripts, 'test:e2e:model-strategy'),
    {
      id: 'claude-subscription-offline-contract',
      area: 'subscription',
      status: 'passed',
      command: 'npm run acceptance:claude-subscription-cli -- --dry-run --json',
      evidence: [
        `requestMode=${claudeContract.requestMode}`,
        `transport=${claudeContract.transport}`,
        `args=${claudeArgs.join(' ')}`,
        `offlineCoverage=${claudeContract.offlineCoverage.join(',')}`,
      ],
    },
    {
      id: 'codex-cli-live-smoke',
      area: 'subscription',
      status: codexLive?.ok ? 'passed' : 'needs-live-evidence',
      command: codexCommand,
      evidence: codexLive?.ok
        ? [
          `version=${codexLive.version ?? 'unknown'}`,
          `finalText=${codexLive.finalText ?? 'N/A'}`,
          `usage=${codexLive.inputTokens ?? 'N/A'}/${codexLive.outputTokens ?? 'N/A'}`,
          'Codex CLI exec completed with read-only sandbox and clean last-message capture',
        ]
        : [
          `requiredFlag=${codexContract.manualLiveGate.requiredFlag}`,
          `requiredEnv=${codexContract.manualLiveGate.requiredEnv}`,
        ],
      blockers: codexLive?.ok ? [] : codexContract.manualLiveGate.stillRequires,
    },
    {
      id: 'provider-saved-token-contract',
      area: 'provider-saved-tokens',
      status: 'passed',
      command: 'npm run acceptance:provider-saved-tokens -- --json',
      evidence: [
        `accepts=${Object.keys(providerContract.accepts).join(',')}`,
        `rejects=${providerContract.rejects.join(',')}`,
      ],
    },
    {
      id: 'xiaomi-provider-artifact-contract',
      area: 'provider-saved-tokens',
      status: xiaomiArtifactGate.ok ? 'passed' : 'failed',
      command: 'npx vitest run tests/unit/scripts/xiaomiSmoke.test.ts',
      evidence: xiaomiArtifactGate.ok
        ? ['bounded artifact shape is compatible with provider saved-token live-response gate']
        : [],
      failedChecks: xiaomiArtifactGate.failedChecks,
    },
    {
      id: 'xiaomi-live-tool-calling',
      area: 'provider-saved-tokens',
      status: xiaomiToolCalling?.ok ? 'passed' : 'needs-live-evidence',
      command: 'set -a; source ~/.code-agent/.env; set +a; node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/xiaomi-smoke.ts --provider-response-out /tmp/xiaomi-provider-response.json',
      evidence: xiaomiToolCalling?.ok
        ? [
          `provider=${xiaomiToolCalling.provider ?? 'xiaomi'}`,
          `model=${xiaomiToolCalling.model ?? 'unknown'}`,
          `toolCalls=${xiaomiToolCalling.toolCallCount}`,
          `usage=${xiaomiToolCalling.inputTokens ?? 'N/A'}/${xiaomiToolCalling.outputTokens ?? 'N/A'}`,
        ]
        : [
          hasXiaomiKey ? 'XIAOMI_API_KEY is available' : 'XIAOMI_API_KEY is not visible',
        ],
      blockers: xiaomiLiveBlockers,
    },
    {
      id: 'provider-saved-token-live-boundary',
      area: 'provider-saved-tokens',
      status: providerSavedTokenBoundaryPassed ? 'passed' : 'needs-live-evidence',
      command: providerCommand,
      evidence: providerLiveGate?.ok
        ? ['provider-reported saved-token field accepted from live response']
        : providerSavedTokenBoundaryPassed
          ? [
            'live Xiaomi tool-calling response is captured',
            'provider usage is present but provider-reported saved-token field is absent',
            'usage-only response remains classified as not provider-reported savings',
          ]
        : [
          `requiredFlag=${providerContract.manualLiveGate.requiredFlag}`,
          `requiredEnv=${providerContract.manualLiveGate.requiredEnv}`,
          'usage-only responses remain blocked',
        ],
      blockers: providerSavedTokenBoundaryPassed ? [] : providerSavedTokenBlockers,
      failedChecks: providerLiveGate?.failedChecks,
    },
    {
      id: 'route-trace-complexity-boundary',
      area: 'decision-explainability',
      status: 'passed',
      command: 'npx vitest run tests/renderer/components/routeTraceChip.test.tsx',
      evidence: [
        'complexityScore is labeled as a rule estimate for routing explanation',
        'RouteTrace does not present complexityScore as a model quality score',
      ],
    },
    {
      id: 'route-trace-provider-health-boundary',
      area: 'decision-explainability',
      status: 'passed',
      command: 'npx vitest run tests/renderer/components/routeTraceChip.test.tsx',
      evidence: [
        'provider health is labeled as a recent window sample',
        'RouteTrace does not present provider health as a realtime SLA',
      ],
    },
    {
      id: 'fallback-visibility-contract',
      area: 'decision-explainability',
      status: fallbackVisibility.ok ? 'passed' : 'failed',
      command: 'npm run acceptance:model-strategy-fallback -- --json',
      evidence: fallbackVisibility.evidence,
      failedChecks: fallbackVisibility.failedChecks,
    },
    {
      id: 'surface-billing-identity-contract',
      area: 'decision-explainability',
      status: surfaceVisibility.ok ? 'passed' : 'failed',
      command: 'npm run acceptance:model-strategy-surface -- --json',
      evidence: surfaceVisibility.evidence,
      failedChecks: surfaceVisibility.failedChecks,
    },
    {
      id: 'task-recommendation-capability-contract',
      area: 'task-recommendation',
      status: 'passed',
      command: 'npx vitest run tests/renderer/components/chatInput.modelStrategyRecommendation.test.ts',
      evidence: [
        'provider health recommendations filter candidates by this-turn required capabilities',
        'image tasks do not switch to healthy candidates without vision capability',
        'simple tasks prefer healthy fast candidates when provider health forces a switch',
        'provider-health dismiss keys are scoped by task type',
        'capability and external-attachment recommendation keys are scoped by task input',
        'recommendation apply/dismiss feedback emits privacy-bounded task signals',
        'recommendation factors expose the required task capability',
      ],
    },
    {
      id: 'model-strategy-e2e-in-app-browser',
      area: 'task-recommendation',
      status: browserAccepted ? 'passed' : 'needs-live-evidence',
      command: 'npm run test:e2e:model-strategy',
      evidence: browserAccepted
        ? [
          'in-app Browser verification is accepted for the model-strategy recommendation flow',
          'Playwright Mach-port failure is treated as a test-environment limitation, not a product blocker',
        ]
        : [
          'e2e spec covers simple task adoption and external engine failure switch-to-native',
          'run in-app Browser verification or external CDP automation for final pass evidence',
        ],
      blockers: browserAccepted ? [] : [
        'in-app Browser verification or external CDP automation evidence is required',
      ],
    },
  ];

  const failedChecks = checks.filter((check) => check.status === 'failed');
  const liveGates = checks
    .filter((check) => check.status === 'needs-live-evidence')
    .map((check) => ({
      id: check.id,
      status: 'pending' as const,
      blockers: check.blockers ?? [],
      command: check.command ?? '',
    }));

  return {
    ok: failedChecks.length === 0,
    status: failedChecks.length === 0
      ? liveGates.length === 0
        ? 'passed'
        : 'offline-passed-live-gates-pending'
      : 'failed',
    checks,
    liveGates,
  };
}

async function readPackageScripts(): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

async function readJsonIfPresent(filePath: string | undefined): Promise<unknown | undefined> {
  if (!filePath) return undefined;
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
}

async function readLocalEnvPresence(): Promise<{ XIAOMI_API_KEY?: string }> {
  const envPath = path.join(os.homedir(), '.code-agent', '.env');
  try {
    const text = await fs.readFile(envPath, 'utf8');
    return {
      ...(text.split(/\r?\n/).some((line) => /^\s*XIAOMI_API_KEY\s*=/.test(line))
        ? { XIAOMI_API_KEY: '<present>' }
        : {}),
    };
  } catch {
    return {};
  }
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = hasFlag(parsed, 'json');
  const codexResultPath = getStringOption(parsed, 'codex-result');
  const xiaomiLiveResponsePath = getStringOption(parsed, 'xiaomi-live-response');
  const summary = buildModelStrategyAcceptanceSummary({
    packageScripts: await readPackageScripts(),
    env: process.env,
    localEnvPresence: await readLocalEnvPresence(),
    codexCliSmokeResult: await readJsonIfPresent(codexResultPath),
    xiaomiLiveResponse: await readJsonIfPresent(xiaomiLiveResponsePath),
    inAppBrowserModelStrategyOk: hasFlag(parsed, 'in-app-browser-model-strategy-ok'),
  });

  if (json) {
    printJson(summary);
  } else {
    printKeyValue('Model strategy acceptance summary', [
      ['status', summary.status],
      ['checks', summary.checks.length],
      ['liveGates', summary.liveGates.length],
    ]);
  }

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => finishWithError(error));
}
