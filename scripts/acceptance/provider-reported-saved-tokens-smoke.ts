#!/usr/bin/env npx tsx

import * as fs from 'fs/promises';
import { pathToFileURL } from 'url';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';

export interface ProviderReportedSavedTokensSmokeContract {
  mode: 'provider-reported-saved-token-contract';
  accepts: {
    tokenSavingsStatus: 'provider-reported';
    providerReportSource: 'provider-reported';
    measurementSavingsSource: 'provider-reported';
    measurementProviderReportedSavings: true;
  };
  rejects: string[];
  manualLiveGate: {
    requiredFlag: '--manual-provider';
    requiredEnv: 'CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1';
    stillRequires: string[];
  };
}

export interface ProviderReportedSavedTokensSmokeResult {
  ok: boolean;
  status: 'passed' | 'blocked' | 'failed';
  mode: 'model-decision-fixture' | 'provider-live-response-artifact';
  fixture: string | null;
  liveResponse: string | null;
  savedTokens: number | null;
  providerUsage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  checks: Record<string, boolean>;
  failedChecks: string[];
  contract: ProviderReportedSavedTokensSmokeContract;
}

const DEFAULT_FIXTURE = 'tests/fixtures/provider-reported-saved-tokens-decision.json';

function usage(): void {
  console.log(`Provider-reported saved-token contract smoke

Usage:
  npm run acceptance:provider-saved-tokens -- [options]

Options:
  --fixture <path>  Model decision JSON fixture. Default: ${DEFAULT_FIXTURE}
  --live-response <path>
                    Real provider response JSON artifact to validate for
                    usage.providerReportedSavedTokens or an equivalent
                    provider/tool saved-token field.
  --manual-provider Required with --live-response to acknowledge this is real
                    provider evidence, not a checked-in fixture.
  --json            Print JSON output.
  --help            Show this help.

By default this smoke validates the local model-decision contract for
provider-reported programmatic tool saved tokens. With --live-response it gates
a captured real provider response artifact and refuses to treat usage-only
responses as provider-reported saved-token evidence.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readPath<T = unknown>(value: unknown, path: string[]): T | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current as T | undefined;
}

function readFirstNumber(value: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const parsed = finiteNumber(readPath<unknown>(value, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function buildProviderReportedSavedTokensSmokeContract(): ProviderReportedSavedTokensSmokeContract {
  return {
    mode: 'provider-reported-saved-token-contract',
    accepts: {
      tokenSavingsStatus: 'provider-reported',
      providerReportSource: 'provider-reported',
      measurementSavingsSource: 'provider-reported',
      measurementProviderReportedSavings: true,
    },
    rejects: [
      'provider usage alone as saved-token evidence',
      'tool-spec local estimate basis mixed into provider-reported savings',
      'provider-reported status without providerReport.savedTokens',
    ],
    manualLiveGate: {
      requiredFlag: '--manual-provider',
      requiredEnv: 'CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1',
      stillRequires: [
        'real provider response with usage.providerReportedSavedTokens or equivalent provider/tool saved-token field',
        'programmatic tool calling enabled in a live request',
        'live evidence that provider-reported saved tokens survive modelDecision event normalization',
      ],
    },
  };
}

export function validateProviderReportedSavedTokensDecision(args: {
  decision: unknown;
  fixture?: string | null;
}): ProviderReportedSavedTokensSmokeResult {
  const tokenSavings = readPath<Record<string, unknown>>(args.decision, ['toolStrategy', 'tokenSavings']);
  const status = tokenSavings?.status;
  const savedTokens = finiteNumber(tokenSavings?.savedTokens);
  const providerReportSource = readPath<unknown>(tokenSavings, ['providerReport', 'source']);
  const providerReportSavedTokens = finiteNumber(readPath<unknown>(tokenSavings, ['providerReport', 'savedTokens']));
  const measurementSavingsSource = readPath<unknown>(tokenSavings, ['measurement', 'savingsSource']);
  const measurementUsageSource = readPath<unknown>(tokenSavings, ['measurement', 'usageSource']);
  const providerReportedSavings = readPath<unknown>(tokenSavings, ['measurement', 'providerReportedSavings']);
  const usageInputTokens = finiteNumber(readPath<unknown>(tokenSavings, ['providerUsage', 'inputTokens']));
  const usageOutputTokens = finiteNumber(readPath<unknown>(tokenSavings, ['providerUsage', 'outputTokens']));
  const usageTotalTokens = finiteNumber(readPath<unknown>(tokenSavings, ['providerUsage', 'totalTokens']));
  const basis = readPath<unknown>(tokenSavings, ['basis']);

  const checks: Record<string, boolean> = {
    tokenSavingsPresent: isRecord(tokenSavings),
    statusIsProviderReported: status === 'provider-reported',
    savedTokensIsFinite: savedTokens !== null && savedTokens >= 0,
    providerReportPresent: providerReportSource === 'provider-reported',
    providerReportMatchesSavedTokens: savedTokens !== null && providerReportSavedTokens === savedTokens,
    measurementMarksProviderReported: measurementSavingsSource === 'provider-reported' && providerReportedSavings === true,
    providerUsagePresent: measurementUsageSource === 'model-response-usage' && usageInputTokens !== null && usageOutputTokens !== null,
    localEstimateBasisAbsent: basis === undefined,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    ok: failedChecks.length === 0,
      status: failedChecks.length === 0 ? 'passed' : 'failed',
      mode: 'model-decision-fixture',
      fixture: args.fixture ?? null,
      liveResponse: null,
      savedTokens,
      providerUsage: {
        inputTokens: usageInputTokens,
        outputTokens: usageOutputTokens,
        totalTokens: usageTotalTokens,
    },
    checks,
    failedChecks,
    contract: buildProviderReportedSavedTokensSmokeContract(),
  };
}

export function validateProviderReportedSavedTokensLiveResponse(args: {
  response: unknown;
  liveResponse?: string | null;
}): ProviderReportedSavedTokensSmokeResult {
  const savedTokens = readFirstNumber(args.response, [
    ['usage', 'providerReportedSavedTokens'],
    ['usage', 'provider_reported_saved_tokens'],
    ['providerReportedSavedTokens'],
    ['provider_reported_saved_tokens'],
    ['toolUsage', 'savedTokens'],
    ['tool_usage', 'saved_tokens'],
  ]);
  const inputTokens = readFirstNumber(args.response, [
    ['usage', 'inputTokens'],
    ['usage', 'input_tokens'],
    ['usage', 'prompt_tokens'],
  ]);
  const outputTokens = readFirstNumber(args.response, [
    ['usage', 'outputTokens'],
    ['usage', 'output_tokens'],
    ['usage', 'completion_tokens'],
  ]);
  const totalTokens = readFirstNumber(args.response, [
    ['usage', 'totalTokens'],
    ['usage', 'total_tokens'],
  ]) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);

  const checks: Record<string, boolean> = {
    liveResponsePresent: isRecord(args.response),
    providerReportedSavedTokensPresent: savedTokens !== null,
    providerReportedSavedTokensFinite: savedTokens !== null && savedTokens >= 0,
    providerUsagePresent: inputTokens !== null && outputTokens !== null,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const missingOnlySavedTokens = failedChecks.every((check) => (
    check === 'providerReportedSavedTokensPresent'
    || check === 'providerReportedSavedTokensFinite'
  ));

  return {
    ok: failedChecks.length === 0,
    status: failedChecks.length === 0 ? 'passed' : missingOnlySavedTokens ? 'blocked' : 'failed',
    mode: 'provider-live-response-artifact',
    fixture: null,
    liveResponse: args.liveResponse ?? null,
    savedTokens,
    providerUsage: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
    checks,
    failedChecks,
    contract: buildProviderReportedSavedTokensSmokeContract(),
  };
}

export function validateProviderReportedSavedTokensLiveGate(args: {
  manualProvider: boolean;
  env?: Pick<NodeJS.ProcessEnv, 'CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE'>;
}): void {
  if (!args.manualProvider) {
    throw new Error('Provider saved-token live response smoke is manual-only. Pass --manual-provider to acknowledge real provider evidence.');
  }
  if (args.env?.CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE !== '1') {
    throw new Error('Provider saved-token live response smoke requires CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1.');
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (hasFlag(parsed, 'help')) {
    usage();
    return;
  }

  const json = hasFlag(parsed, 'json');
  const liveResponse = getStringOption(parsed, 'live-response');
  const manualProvider = hasFlag(parsed, 'manual-provider');
  if (liveResponse) {
    validateProviderReportedSavedTokensLiveGate({ manualProvider, env: process.env });
    const response = JSON.parse(await fs.readFile(liveResponse, 'utf8')) as unknown;
    const result = validateProviderReportedSavedTokensLiveResponse({ response, liveResponse });

    if (json) printJson(result);
    else printKeyValue('Provider-reported saved-token live response smoke', [
      ['status', result.status],
      ['liveResponse', result.liveResponse],
      ['savedTokens', result.savedTokens],
      ['inputTokens', result.providerUsage.inputTokens],
      ['outputTokens', result.providerUsage.outputTokens],
      ['failedChecks', result.failedChecks.join(', ') || null],
    ]);

    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const fixture = getStringOption(parsed, 'fixture') ?? DEFAULT_FIXTURE;
  const decision = JSON.parse(await fs.readFile(fixture, 'utf8')) as unknown;
  const result = validateProviderReportedSavedTokensDecision({ decision, fixture });

  if (json) printJson(result);
  else printKeyValue('Provider-reported saved-token contract smoke', [
    ['status', result.status],
    ['fixture', result.fixture],
    ['savedTokens', result.savedTokens],
    ['inputTokens', result.providerUsage.inputTokens],
    ['outputTokens', result.providerUsage.outputTokens],
    ['failedChecks', result.failedChecks.join(', ') || null],
  ]);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => finishWithError(error));
}
