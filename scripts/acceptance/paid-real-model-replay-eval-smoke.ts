#!/usr/bin/env npx tsx

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import process from 'process';
import { config as loadDotenv } from 'dotenv';
import { redactSecrets, sanitizeLogValue } from '../../src/host/security/secretRedaction';

loadDotenv({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const MARKER = 'PAID_REAL_MODEL_REPLAY_EVAL_FIXTURE';

const PROVIDERS = {
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4o-mini',
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
  },
} as const;

type PaidProvider = keyof typeof PROVIDERS;

const INPUT_PRICE_ENV = 'CODE_AGENT_PAID_SMOKE_INPUT_USD_PER_1M';
const OUTPUT_PRICE_ENV = 'CODE_AGENT_PAID_SMOKE_OUTPUT_USD_PER_1M';
const BASE_URL_ENV = 'CODE_AGENT_PAID_SMOKE_BASE_URL';
const API_KEY_FILE_ENV = 'CODE_AGENT_PAID_SMOKE_API_KEY_FILE';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fail(message: string, details?: unknown): never {
  const suffix = details === undefined ? '' : `\n${asJson(sanitizeLogValue(details))}`;
  throw new Error(redactSecrets(`${message}${suffix}`));
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid positive number for ${name}`, { value: raw });
  }
  return parsed;
}

function readBaseUrl(providerConfig: { baseUrlEnv: string }): string | undefined {
  const raw = process.env[BASE_URL_ENV] || process.env[providerConfig.baseUrlEnv];
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail('Invalid paid smoke base URL.', {
      env: process.env[BASE_URL_ENV] ? BASE_URL_ENV : providerConfig.baseUrlEnv,
      value: trimmed,
    });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('Paid smoke base URL must use http or https.', {
      env: process.env[BASE_URL_ENV] ? BASE_URL_ENV : providerConfig.baseUrlEnv,
      protocol: parsed.protocol,
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('Paid smoke base URL must not include credentials, query, or fragment.', {
      env: process.env[BASE_URL_ENV] ? BASE_URL_ENV : providerConfig.baseUrlEnv,
      origin: parsed.origin,
      pathname: parsed.pathname,
    });
  }

  return trimmed.replace(/\/+$/, '');
}

function readProvider(): PaidProvider {
  const value = (process.env.CODE_AGENT_PAID_SMOKE_PROVIDER || 'openai').toLowerCase();
  if (value !== 'openai') {
    fail('Paid real-model smoke currently supports only the OpenAI provider.', {
      provider: value,
      supportedProviders: Object.keys(PROVIDERS),
    });
  }
  return value;
}

async function readApiKey(providerConfig: { apiKeyEnv: string }): Promise<{ apiKey: string; source: string }> {
  const apiKeyFile = process.env[API_KEY_FILE_ENV]?.trim();
  if (apiKeyFile) {
    let fileContent: string;
    try {
      fileContent = await readFile(path.resolve(process.cwd(), apiKeyFile), 'utf8');
    } catch (error) {
      fail(`Failed to read ${API_KEY_FILE_ENV}.`, {
        path: apiKeyFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const apiKey = fileContent.trim();
    if (!apiKey) {
      fail(`${API_KEY_FILE_ENV} points to an empty key file.`, { path: apiKeyFile });
    }
    return { apiKey, source: API_KEY_FILE_ENV };
  }

  const apiKey = process.env[providerConfig.apiKeyEnv]?.trim();
  if (!apiKey) {
    fail(`Missing ${providerConfig.apiKeyEnv}.`, {
      alternatives: [API_KEY_FILE_ENV],
    });
  }
  return { apiKey, source: providerConfig.apiKeyEnv };
}

function buildGuardrails(provider: PaidProvider) {
  const providerConfig = PROVIDERS[provider];
  const model = process.env.CODE_AGENT_PAID_SMOKE_MODEL || providerConfig.defaultModel;
  const baseUrl = readBaseUrl(providerConfig);
  const customModel = model !== providerConfig.defaultModel;
  if (customModel && (!process.env[INPUT_PRICE_ENV] || !process.env[OUTPUT_PRICE_ENV])) {
    fail('Custom paid smoke model requires explicit pricing env vars to avoid underestimating spend.', {
      model,
      defaultModel: providerConfig.defaultModel,
      requiredEnv: [INPUT_PRICE_ENV, OUTPUT_PRICE_ENV],
    });
  }

  const maxInputTokens = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_MAX_INPUT_TOKENS', 50_000));
  const maxOutputTokens = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_MAX_OUTPUT_TOKENS', 192));
  const maxModelCalls = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_MAX_MODEL_CALLS', 3));
  const maxUsd = readNumberEnv('CODE_AGENT_PAID_SMOKE_MAX_USD', 0.05);
  const requestTimeoutMs = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_REQUEST_TIMEOUT_MS', 45_000));
  const firstByteTimeoutMs = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_FIRST_BYTE_TIMEOUT_MS', 20_000));
  const inactivityTimeoutMs = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_INACTIVITY_TIMEOUT_MS', 30_000));
  const caseTimeoutMs = Math.floor(readNumberEnv('CODE_AGENT_PAID_SMOKE_CASE_TIMEOUT_MS', 60_000));
  const inputUsdPer1M = readNumberEnv(INPUT_PRICE_ENV, providerConfig.inputUsdPer1M);
  const outputUsdPer1M = readNumberEnv(OUTPUT_PRICE_ENV, providerConfig.outputUsdPer1M);
  const estimatedMaxUsd = maxModelCalls * (
    (maxInputTokens * inputUsdPer1M + maxOutputTokens * outputUsdPer1M) / 1_000_000
  );

  if (estimatedMaxUsd > maxUsd) {
    fail('Paid smoke budget cap would be exceeded before making a request.', {
      estimatedMaxUsd,
      maxUsd,
      maxInputTokens,
      maxOutputTokens,
      maxModelCalls,
      inputUsdPer1M,
      outputUsdPer1M,
    });
  }

  return {
    provider,
    providerConfig,
    model,
    baseUrl,
    maxInputTokens,
    maxOutputTokens,
    maxModelCalls,
    maxUsd,
    estimatedMaxUsd,
    inputUsdPer1M,
    outputUsdPer1M,
    pricingSource: customModel ? 'explicit-env' : 'default-model-table',
    requestTimeoutMs,
    firstByteTimeoutMs,
    inactivityTimeoutMs,
    caseTimeoutMs,
  };
}

async function main(): Promise<void> {
  const json = hasFlag('--json');
  const dryRun = hasFlag('--dry-run');
  const manualPaid = hasFlag('--manual-paid');
  const keepTmp = hasFlag('--keep-tmp') || process.env.CODE_AGENT_ACCEPTANCE_KEEP_TMP === '1';
  const provider = readProvider();
  const guardrails = buildGuardrails(provider);

  if (dryRun) {
    const output = {
      ok: true,
      dryRun: true,
      provider,
      model: guardrails.model,
      requiredEnv: [
        'CODE_AGENT_PAID_SMOKE=1',
        `${guardrails.providerConfig.apiKeyEnv} or ${API_KEY_FILE_ENV}`,
        `${BASE_URL_ENV} or ${guardrails.providerConfig.baseUrlEnv} when using an OpenAI-compatible proxy`,
      ],
      requiredFlag: '--manual-paid',
      guardrails: {
        maxInputTokens: guardrails.maxInputTokens,
        maxOutputTokens: guardrails.maxOutputTokens,
        maxModelCalls: guardrails.maxModelCalls,
        runtimeMaxIterations: guardrails.maxModelCalls,
        maxUsd: guardrails.maxUsd,
        estimatedMaxUsd: guardrails.estimatedMaxUsd,
        inputUsdPer1M: guardrails.inputUsdPer1M,
        outputUsdPer1M: guardrails.outputUsdPer1M,
        pricingSource: guardrails.pricingSource,
        baseUrlConfigured: Boolean(guardrails.baseUrl),
        baseUrl: guardrails.baseUrl,
        requestTimeoutMs: guardrails.requestTimeoutMs,
        firstByteTimeoutMs: guardrails.firstByteTimeoutMs,
        inactivityTimeoutMs: guardrails.inactivityTimeoutMs,
        caseTimeoutMs: guardrails.caseTimeoutMs,
        providerRetryDisabled: true,
        runtimeNetworkRetryDisabled: true,
        providerFallbackDisabledByExplicitModel: true,
      },
    };
    console.log(json ? asJson(output) : `Paid real-model smoke dry run passed\n${asJson(output)}`);
    return;
  }

  if (!manualPaid) {
    fail('Paid real-model smoke is manual-only. Pass --manual-paid to acknowledge spend.');
  }
  if (process.env.CODE_AGENT_PAID_SMOKE !== '1') {
    fail('Paid real-model smoke requires CODE_AGENT_PAID_SMOKE=1.');
  }

  const { apiKey, source: apiKeySource } = await readApiKey(guardrails.providerConfig);

  const repoRoot = process.cwd();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agent-neo-paid-real-model-'));
  const workspaceDir = path.join(dataDir, 'workspace');
  const testCaseDir = path.join(dataDir, 'test-cases');
  const resultsDir = path.join(dataDir, 'test-results');
  const fixturePath = path.join(workspaceDir, 'paid-real-model-target.txt');

  try {
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(testCaseDir, { recursive: true });
    await writeFile(
      fixturePath,
      [
        `${MARKER}=true`,
        'This synthetic fixture proves a paid external model reached the real Read tool executor.',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(testCaseDir, 'paid-real-model-replay-eval-smoke.yaml'),
      asJson({
        name: 'paid-real-model-replay-eval-smoke',
        description: 'Manual paid provider smoke for real AgentLoop tool execution and replay evidence.',
        default_timeout: guardrails.caseTimeoutMs,
        cases: [
          {
            id: 'paid-real-model-replay-eval-smoke',
            type: 'task',
            description: 'Use a paid external model to call Read on a synthetic fixture.',
            prompt: `Call the Read tool exactly once for this path: ${fixturePath}. Then reply with the marker value exactly: ${MARKER}.`,
            tags: ['smoke', 'real-agent-run', 'manual-paid'],
            timeout: guardrails.caseTimeoutMs,
            expect: {
              tool: 'Read',
              success: true,
              args_match: {
                file_path: fixturePath,
              },
              output_contains: [MARKER],
              response_contains: [MARKER],
              min_tool_calls: 1,
              max_tool_calls: 1,
              max_turns: guardrails.maxModelCalls,
            },
          },
        ],
      }),
      'utf8',
    );

    process.env.CODE_AGENT_DATA_DIR = dataDir;
    process.env.CODE_AGENT_E2E = '1';
    delete process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL;
    delete process.env.CODE_AGENT_E2E_AGENT_MODEL_READ_FILE;
    process.env.CODE_AGENT_MODEL_ENGINE = process.env.CODE_AGENT_PAID_SMOKE_ENGINE
      || process.env.CODE_AGENT_MODEL_ENGINE
      || 'legacy';
    process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';

    const { getProtocolRegistry } = await import('../../src/host/tools/protocolRegistry');
    getProtocolRegistry();

    const { getDatabase } = await import('../../src/host/services/core/databaseService');
    const testing = await import('../../src/host/testing/index');
    const { getTelemetryQueryService } = await import('../../src/host/evaluation/telemetryQueryService');

    await getDatabase().initialize();

    const config = testing.createDefaultConfig(repoRoot, {
      testCaseDir,
      resultsDir,
      workingDirectory: workspaceDir,
      defaultTimeout: guardrails.caseTimeoutMs,
      stopOnFailure: true,
      verbose: false,
      parallel: false,
      maxParallel: 1,
      enableEvalCritic: false,
      toolMode: 'deferred',
    });

    const agent = new testing.StandaloneAgentAdapter({
      workingDirectory: workspaceDir,
      generation: 'paid-real-model-replay-eval',
      modelConfig: {
        provider,
        model: guardrails.model,
        apiKey,
        baseUrl: guardrails.baseUrl,
        temperature: 0,
        maxTokens: guardrails.maxOutputTokens,
        adaptive: false,
      },
      maxIterations: guardrails.maxModelCalls,
      inferenceOptions: {
        disableProviderTransientRetry: true,
        disableRuntimeNetworkRetry: true,
        maxInputTokens: guardrails.maxInputTokens,
        maxOutputTokens: guardrails.maxOutputTokens,
        requestTimeoutMs: guardrails.requestTimeoutMs,
        firstByteTimeoutMs: guardrails.firstByteTimeoutMs,
        inactivityTimeoutMs: guardrails.inactivityTimeoutMs,
      },
      toolMode: 'deferred',
    });

    const runner = new testing.TestRunner(config, agent);
    const summary = await runner.runAll();
    const result = summary.results[0];
    if (summary.total !== 1 || !result) {
      fail('Expected exactly one paid smoke result.', { total: summary.total });
    }
    if (result.status !== 'passed') {
      fail('Paid real-model replay/eval smoke failed.', result);
    }
    if (result.telemetryGate?.passed !== true) {
      fail('real-agent-run telemetry gate did not pass.', result.telemetryGate);
    }
    if (!result.sessionId || !result.replayKey) {
      fail('Paid smoke result is missing sessionId or replayKey.', {
        sessionId: result.sessionId,
        replayKey: result.replayKey,
      });
    }

    const replay = await getTelemetryQueryService().getStructuredReplay(result.sessionId);
    const blocks = replay?.turns.flatMap((turn) => turn.blocks) ?? [];
    const modelBlocks = blocks.filter((block) => block.type === 'model_call' && block.modelDecision);
    const toolBlock = blocks.find((block) => block.type === 'tool_call' && block.toolCall?.name === 'Read');
    if (!replay || replay.dataSource !== 'telemetry') {
      fail('Structured replay did not come from telemetry.', replay);
    }
    if (!modelBlocks.some((block) => block.modelDecision?.toolSchemas?.some((schema) => schema.name === 'Read'))) {
      fail('Structured replay is missing the Read tool schema on model decision.', modelBlocks);
    }
    if (!toolBlock?.toolCall?.successKnown || !String(toolBlock.toolCall.result ?? '').includes(MARKER)) {
      fail('Structured replay is missing the successful Read tool result.', toolBlock);
    }

    const actualInputTokens = modelBlocks.reduce((sum, block) => sum + (block.modelDecision?.inputTokens ?? 0), 0);
    const actualOutputTokens = modelBlocks.reduce((sum, block) => sum + (block.modelDecision?.outputTokens ?? 0), 0);
    const actualEstimatedUsd = (
      actualInputTokens * guardrails.inputUsdPer1M
      + actualOutputTokens * guardrails.outputUsdPer1M
    ) / 1_000_000;
    if (actualEstimatedUsd > guardrails.maxUsd) {
      fail('Paid smoke actual estimated cost exceeded the configured cap.', {
        actualEstimatedUsd,
        maxUsd: guardrails.maxUsd,
        actualInputTokens,
        actualOutputTokens,
      });
    }

    const output = {
      ok: true,
      paid: true,
      dataDir: keepTmp ? dataDir : undefined,
      provider,
      model: guardrails.model,
      apiKeySource,
      engine: process.env.CODE_AGENT_MODEL_ENGINE,
      sessionId: result.sessionId,
      replayKey: result.replayKey,
      status: result.status,
      budget: {
        maxUsd: guardrails.maxUsd,
        estimatedMaxUsd: guardrails.estimatedMaxUsd,
        actualEstimatedUsd,
        actualInputTokens,
        actualOutputTokens,
      },
      guardrails: {
        maxInputTokens: guardrails.maxInputTokens,
        maxOutputTokens: guardrails.maxOutputTokens,
        maxModelCalls: guardrails.maxModelCalls,
        runtimeMaxIterations: guardrails.maxModelCalls,
        baseUrlConfigured: Boolean(guardrails.baseUrl),
        baseUrl: guardrails.baseUrl,
        requestTimeoutMs: guardrails.requestTimeoutMs,
        firstByteTimeoutMs: guardrails.firstByteTimeoutMs,
        inactivityTimeoutMs: guardrails.inactivityTimeoutMs,
        caseTimeoutMs: guardrails.caseTimeoutMs,
        providerRetryDisabled: true,
        runtimeNetworkRetryDisabled: true,
        providerFallbackDisabledByExplicitModel: true,
      },
      telemetryGate: result.telemetryGate,
      telemetryCompleteness: result.telemetryCompleteness,
      replay: {
        turns: replay.turns.length,
        dataSource: replay.dataSource,
        modelBlocks: modelBlocks.length,
        toolBlocks: blocks.filter((block) => block.type === 'tool_call').length,
        hasReadSchema: true,
        hasReadResult: true,
      },
    };

    if (json) {
      console.log(asJson(output));
    } else {
      console.log('Paid real-model replay/eval smoke passed');
      console.log(asJson(output));
    }
  } finally {
    if (!keepTmp) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
