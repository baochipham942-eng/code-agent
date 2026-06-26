#!/usr/bin/env npx tsx

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { classifyAgentEngineFailure } from '../../src/host/services/agentEngine/agentEngineFailureDiagnostics';

export interface CodexCliEngineSmokeConfig {
  binary: string;
  cwd: string;
  model?: string;
  prompt: string;
  expectedText: string;
  timeoutMs: number;
}

export interface CodexCliEngineSmokeContract {
  requestMode: 'codex-exec';
  transport: 'prompt-argument';
  model: string | null;
  stream: {
    outputFormat: 'jsonl';
    expectedEvents: string[];
  };
  permissions: {
    sandbox: 'read-only';
    gitRepoCheck: 'skipped-for-smoke';
    outputLastMessage: true;
  };
  transcript: {
    mode: 'clean-last-message';
    terminalNoiseFiltered: true;
    expectedMarkerRequired: true;
  };
  offlineCoverage: string[];
  manualLiveGate: {
    requiredFlag: '--manual-codex';
    requiredEnv: 'CODE_AGENT_CODEX_CLI_SMOKE=1';
    stillRequires: string[];
  };
}

export interface CodexCliParsedEvent {
  type?: string;
  itemType?: string;
  text?: string;
  error?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

export interface CodexCliEngineSmokeResult {
  ok: boolean;
  status: 'passed' | 'blocked' | 'failed';
  version?: string;
  contract?: CodexCliEngineSmokeContract;
  finalText?: string;
  threadId?: string;
  outputLastMessagePath?: string;
  eventCounts: {
    threadStarted: number;
    turnStarted: number;
    agentMessage: number;
    errorItem: number;
    turnCompleted: number;
    usage: number;
    parseError: number;
  };
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  failure?: ReturnType<typeof classifyAgentEngineFailure>;
}

function usage(): void {
  console.log(`Codex CLI engine smoke

Usage:
  npm run acceptance:codex-cli-engine -- [options]

Options:
  --dry-run          Print command, structured contract, and required env.
  --probe-only       Run only "codex --version"; no model request.
  --manual-codex     Required for the real Codex exec request.
  --binary <path>    Codex binary. Default: codex.
  --cwd <path>       Workspace cwd. Default: process.cwd().
  --model <model>    Optional Codex model argument.
  --prompt <text>    Prompt to send. Default asks for a fixed marker.
  --expected <text>  Expected marker in the final output.
  --timeout-ms <ms>  Real request timeout. Default: 60000.
  --result-out <path>
                    Write the structured result JSON for summary ingestion.
  --json             Print JSON output.
  --help             Show this help.

The real request is gated by --manual-codex and CODE_AGENT_CODEX_CLI_SMOKE=1.
It validates Codex CLI exec JSONL, read-only sandbox routing, clean final
message capture, usage emission, and auth/quota failure classification.`);
}

export function buildCodexCliEngineSmokeArgs(config: Pick<CodexCliEngineSmokeConfig, 'cwd' | 'model'> & {
  outputLastMessagePath: string;
}): string[] {
  return [
    'exec',
    '--json',
    ...(config.model ? ['--model', config.model] : []),
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '-C',
    config.cwd,
    '--output-last-message',
    config.outputLastMessagePath,
  ];
}

export function buildCodexCliEngineSmokeContract(
  config: Pick<CodexCliEngineSmokeConfig, 'model'>,
): CodexCliEngineSmokeContract {
  return {
    requestMode: 'codex-exec',
    transport: 'prompt-argument',
    model: config.model ?? null,
    stream: {
      outputFormat: 'jsonl',
      expectedEvents: [
        'thread.started',
        'turn.started',
        'item.completed:agent_message',
        'turn.completed',
      ],
    },
    permissions: {
      sandbox: 'read-only',
      gitRepoCheck: 'skipped-for-smoke',
      outputLastMessage: true,
    },
    transcript: {
      mode: 'clean-last-message',
      terminalNoiseFiltered: true,
      expectedMarkerRequired: true,
    },
    offlineCoverage: [
      'command-shape',
      'cli-version-probe',
      'jsonl-parser',
      'read-only-sandbox',
      'expected-marker',
      'usage-emission',
      'auth-quota-runtime-failure-classification',
    ],
    manualLiveGate: {
      requiredFlag: '--manual-codex',
      requiredEnv: 'CODE_AGENT_CODEX_CLI_SMOKE=1',
      stillRequires: [
        'logged-in Codex CLI account',
        'quota-available request',
        'live read-only codex exec request',
        'clean final message capture with usage event',
      ],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseCodexCliEngineSmokeLine(line: string): CodexCliParsedEvent | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: `parse_error: ${line.slice(0, 120)}` };
  }
  if (!isRecord(parsed)) return null;

  const type = typeof parsed.type === 'string' ? parsed.type : undefined;
  const item = isRecord(parsed.item) ? parsed.item : undefined;
  const itemType = typeof item?.type === 'string' ? item.type : undefined;
  const text = typeof item?.text === 'string'
    ? item.text
    : typeof parsed.text === 'string'
      ? parsed.text
      : undefined;
  const usageValue = isRecord(parsed.usage) ? parsed.usage : undefined;

  return {
    type,
    itemType,
    text,
    usage: usageValue ? {
      inputTokens: finiteNumber(usageValue.input_tokens ?? usageValue.inputTokens),
      cachedInputTokens: finiteNumber(usageValue.cached_input_tokens ?? usageValue.cachedInputTokens),
      outputTokens: finiteNumber(usageValue.output_tokens ?? usageValue.outputTokens),
      reasoningOutputTokens: finiteNumber(usageValue.reasoning_output_tokens ?? usageValue.reasoningOutputTokens),
    } : undefined,
  };
}

export async function parseCodexCliEngineSmokeOutput(args: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  expectedText: string;
  outputLastMessagePath?: string;
  occurredAt?: number;
}): Promise<CodexCliEngineSmokeResult> {
  const eventCounts = {
    threadStarted: 0,
    turnStarted: 0,
    agentMessage: 0,
    errorItem: 0,
    turnCompleted: 0,
    usage: 0,
    parseError: 0,
  };
  let finalText = '';
  let threadId: string | undefined;
  let usageValue: CodexCliEngineSmokeResult['usage'];

  for (const line of args.stdout.split(/\r?\n/)) {
    const event = parseCodexCliEngineSmokeLine(line);
    if (!event) continue;
    if (event.error?.startsWith('parse_error:')) {
      eventCounts.parseError += 1;
      continue;
    }
    if (event.type === 'thread.started') {
      eventCounts.threadStarted += 1;
      try {
        const parsed = JSON.parse(line) as { thread_id?: string };
        if (typeof parsed.thread_id === 'string') threadId = parsed.thread_id;
      } catch {
        // Already counted as valid JSON above.
      }
    }
    if (event.type === 'turn.started') eventCounts.turnStarted += 1;
    if (event.type === 'item.completed' && event.itemType === 'agent_message') {
      eventCounts.agentMessage += 1;
      if (event.text) finalText = event.text;
    }
    if (event.type === 'item.completed' && event.itemType === 'error') {
      eventCounts.errorItem += 1;
    }
    if (event.type === 'turn.completed') eventCounts.turnCompleted += 1;
    if (event.usage) {
      eventCounts.usage += 1;
      usageValue = event.usage;
    }
  }

  const lastMessage = args.outputLastMessagePath
    ? await readFileIfExists(args.outputLastMessagePath)
    : undefined;
  const resolvedFinalText = lastMessage || finalText;
  const failureMessage = args.exitCode && args.exitCode !== 0
    ? args.stderr.trim() || `Codex CLI exited with code ${args.exitCode}`
    : '';

  if (failureMessage || args.exitCode !== 0) {
    return {
      ok: false,
      status: 'blocked',
      finalText: resolvedFinalText || undefined,
      threadId,
      outputLastMessagePath: args.outputLastMessagePath,
      eventCounts,
      usage: usageValue,
      failure: classifyAgentEngineFailure({
        engine: 'codex_cli',
        message: failureMessage || 'Codex CLI failed without stderr.',
        exitCode: args.exitCode,
        occurredAt: args.occurredAt,
      }),
    };
  }

  if (!resolvedFinalText.includes(args.expectedText)) {
    return {
      ok: false,
      status: 'failed',
      finalText: resolvedFinalText || undefined,
      threadId,
      outputLastMessagePath: args.outputLastMessagePath,
      eventCounts,
      usage: usageValue,
      failure: classifyAgentEngineFailure({
        engine: 'codex_cli',
        message: `Codex CLI completed but final output did not include expected marker: ${args.expectedText}`,
        exitCode: args.exitCode,
        occurredAt: args.occurredAt,
      }),
    };
  }

  if (eventCounts.turnCompleted === 0 || !usageValue) {
    return {
      ok: false,
      status: 'failed',
      finalText: resolvedFinalText,
      threadId,
      outputLastMessagePath: args.outputLastMessagePath,
      eventCounts,
      usage: usageValue,
      failure: classifyAgentEngineFailure({
        engine: 'codex_cli',
        message: 'Codex CLI completed but did not emit turn.completed usage evidence.',
        exitCode: args.exitCode,
        occurredAt: args.occurredAt,
      }),
    };
  }

  return {
    ok: true,
    status: 'passed',
    finalText: resolvedFinalText,
    threadId,
    outputLastMessagePath: args.outputLastMessagePath,
    eventCounts,
    usage: usageValue,
  };
}

function validateLiveGate(args: {
  manualCodex: boolean;
  env?: Pick<NodeJS.ProcessEnv, 'CODE_AGENT_CODEX_CLI_SMOKE'>;
}): void {
  if (!args.manualCodex) {
    throw new Error('Codex CLI live smoke is manual-only. Pass --manual-codex to acknowledge real Codex CLI execution.');
  }
  if (args.env?.CODE_AGENT_CODEX_CLI_SMOKE !== '1') {
    throw new Error('Codex CLI live smoke requires CODE_AGENT_CODEX_CLI_SMOKE=1.');
  }
}

async function probeVersion(binary: string): Promise<string> {
  const result = await runProcess(binary, ['--version'], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  return (result.stdout || result.stderr).trim();
}

function runProcess(command: string, args: string[], options: {
  cwd: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000).unref?.();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (hasFlag(parsed, 'help')) {
    usage();
    return;
  }

  const json = hasFlag(parsed, 'json');
  const binary = getStringOption(parsed, 'binary') ?? 'codex';
  const cwd = path.resolve(getStringOption(parsed, 'cwd') ?? process.cwd());
  const model = getStringOption(parsed, 'model');
  const expectedText = getStringOption(parsed, 'expected') ?? 'CODEX_MODEL_STRATEGY_OK';
  const prompt = getStringOption(parsed, 'prompt') ?? `只回复 ${expectedText}，不要解释。`;
  const timeoutMs = getNumberOption(parsed, 'timeout-ms') ?? 60_000;
  const resultOut = getStringOption(parsed, 'result-out');
  const contract = buildCodexCliEngineSmokeContract({ model });

  if (hasFlag(parsed, 'dry-run')) {
    const outputLastMessagePath = path.join(os.tmpdir(), 'codex-cli-engine-smoke.last.md');
    const args = buildCodexCliEngineSmokeArgs({ cwd, model, outputLastMessagePath });
    const result = {
      ok: true,
      status: 'passed' as const,
      version: await probeVersion(binary).catch(() => undefined),
      command: [binary, ...args, '<prompt:redacted>'].join(' '),
      contract,
    };
    if (json) printJson(result);
    else printKeyValue('Codex CLI engine smoke dry run', [
      ['status', result.status],
      ['version', result.version],
      ['command', result.command],
      ['requiredFlag', contract.manualLiveGate.requiredFlag],
      ['requiredEnv', contract.manualLiveGate.requiredEnv],
    ]);
    return;
  }

  const version = await probeVersion(binary);
  if (hasFlag(parsed, 'probe-only')) {
    const result = {
      ok: true,
      status: 'passed' as const,
      version,
      contract,
    };
    if (json) printJson(result);
    else printKeyValue('Codex CLI engine smoke probe', [
      ['status', result.status],
      ['version', version],
    ]);
    return;
  }

  validateLiveGate({ manualCodex: hasFlag(parsed, 'manual-codex'), env: process.env });

  const outputLastMessagePath = path.join(
    os.tmpdir(),
    `codex-cli-engine-smoke-${Date.now()}.last.md`,
  );
  const args = [
    ...buildCodexCliEngineSmokeArgs({ cwd, model, outputLastMessagePath }),
    prompt,
  ];
  const raw = await runProcess(binary, args, { cwd, timeoutMs });
  const result = await parseCodexCliEngineSmokeOutput({
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    expectedText,
    outputLastMessagePath,
    occurredAt: Date.now(),
  });
  const resultWithMeta: CodexCliEngineSmokeResult = {
    ...result,
    version,
    contract,
  };

  if (json) printJson(resultWithMeta);
  else printKeyValue('Codex CLI engine smoke', [
    ['status', resultWithMeta.status],
    ['version', version],
    ['finalText', resultWithMeta.finalText],
    ['threadId', resultWithMeta.threadId],
    ['inputTokens', resultWithMeta.usage?.inputTokens],
    ['outputTokens', resultWithMeta.usage?.outputTokens],
    ['outputLastMessagePath', outputLastMessagePath],
    ['failure', resultWithMeta.failure?.reason],
  ]);
  if (resultOut) {
    await fs.writeFile(path.resolve(resultOut), JSON.stringify(resultWithMeta, null, 2), 'utf8');
  }

  if (!resultWithMeta.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => finishWithError(error));
}
