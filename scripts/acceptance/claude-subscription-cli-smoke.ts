#!/usr/bin/env npx tsx

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
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
import { classifyAgentEngineFailure } from '../../src/main/services/agentEngine/agentEngineFailureDiagnostics';

export interface ClaudeSubscriptionSmokeConfig {
  binary: string;
  model?: string;
  prompt: string;
  expectedText: string;
  timeoutMs: number;
}

export interface ClaudeSubscriptionSmokeContract {
  requestMode: 'claude-print';
  transport: 'stdin-text';
  model: string | null;
  stream: {
    outputFormat: 'stream-json';
    includePartialMessages: true;
    expectedEvents: string[];
  };
  permissions: {
    permissionMode: 'plan';
    settingSources: 'local';
    slashCommands: 'disabled';
    sessionPersistence: false;
  };
  tools: {
    policy: 'read-only';
    tools: string[];
    allowedTools: string[];
    strictMcpConfig: true;
    mcpBridge: 'offline-replay-plus-manual-live-gate';
  };
  transcript: {
    mode: 'clean-result-text';
    parseErrorsVisible: true;
    terminalNoiseFiltered: true;
    expectedMarkerRequired: true;
  };
  offlineCoverage: string[];
  manualLiveGate: {
    requiredFlag: '--manual-claude';
    requiredEnv: 'CODE_AGENT_CLAUDE_CLI_SMOKE=1';
    stillRequires: string[];
  };
}

export interface ClaudeSubscriptionParsedEvent {
  type?: string;
  subtype?: string;
  textDelta?: string;
  finalText?: string;
  error?: string;
  statusCode?: number;
  sessionId?: string;
  toolName?: string;
  toolResult?: boolean;
}

export interface ClaudeSubscriptionSmokeResult {
  ok: boolean;
  status: 'passed' | 'blocked' | 'failed';
  version?: string;
  contract?: ClaudeSubscriptionSmokeContract;
  finalText?: string;
  externalSessionId?: string;
  eventCounts: {
    init: number;
    streamDelta: number;
    assistantSnapshot: number;
    toolUse: number;
    mcpToolUse: number;
    toolResult: number;
    result: number;
    parseError: number;
  };
  failure?: ReturnType<typeof classifyAgentEngineFailure>;
}

export interface ClaudeSubscriptionFixtureReplayEvidence {
  mode: 'stream-json-fixture';
  source: string | null;
  observed: {
    streamDelta: number;
    assistantSnapshot: number;
    toolUse: number;
    mcpToolUse: number;
    toolResult: number;
    result: number;
    parseError: number;
  };
  requirements: {
    requireToolUse: boolean;
    requireMcpBridge: boolean;
  };
  checks: {
    expectedMarkerFound: boolean;
    partialDeltasReassembled: boolean;
    assistantSnapshotNotDuplicated: boolean;
    terminalNoiseFiltered: boolean;
    requiredToolUseObserved: boolean;
    requiredMcpToolUseObserved: boolean;
    requiredToolResultObserved: boolean;
    resultEventObserved: boolean;
  };
  failedChecks: string[];
}

export type ClaudeSubscriptionFixtureReplayResult = ClaudeSubscriptionSmokeResult & {
  replay: ClaudeSubscriptionFixtureReplayEvidence;
};

const READ_ONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'LS'] as const;
const READ_ONLY_CLAUDE_TOOLS_ARG = READ_ONLY_CLAUDE_TOOLS.join(',');

function usage(): void {
  console.log(`Claude subscription CLI smoke

Usage:
  npm run acceptance:claude-subscription-cli -- [options]

Options:
  --dry-run             Print command, structured contract, guardrails, and required env without running Claude.
  --probe-only          Run only "claude --version"; no model request.
  --replay-fixture <path>
                        Replay recorded stream-json stdout without running Claude.
  --require-tool-use    With --replay-fixture, fail unless at least one tool_use event is observed.
  --expect-mcp-bridge   With --replay-fixture, fail unless an mcp__ tool_use and tool_result are observed.
  --manual-claude       Required for the real subscription request.
  --binary <path>       Claude binary. Default: claude.
  --model <model>       Optional Claude Code model argument.
  --prompt <text>       Prompt to send. Default asks for a fixed marker.
  --expected <text>     Expected marker in final output.
  --timeout-ms <ms>     Real request timeout. Default: 45000.
  --json                Print JSON output.
  --help                Show this help.

The real request is gated by --manual-claude and CODE_AGENT_CLAUDE_CLI_SMOKE=1.
It validates stream-json, input-format text, clean final result, auth/quota status,
and CLI exit behavior through the same Claude Code print-mode contract used by the app.`);
}

export function buildClaudeSubscriptionSmokeArgs(config: Pick<ClaudeSubscriptionSmokeConfig, 'model'>): string[] {
  return [
    '-p',
    '--verbose',
    ...(config.model ? ['--model', config.model] : []),
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--permission-mode',
    'plan',
    '--setting-sources',
    'local',
    '--disable-slash-commands',
    '--tools',
    READ_ONLY_CLAUDE_TOOLS_ARG,
    '--allowedTools',
    READ_ONLY_CLAUDE_TOOLS_ARG,
    '--strict-mcp-config',
    '--include-partial-messages',
    '--no-session-persistence',
  ];
}

export function buildClaudeSubscriptionSmokeContract(
  config: Pick<ClaudeSubscriptionSmokeConfig, 'model'>,
): ClaudeSubscriptionSmokeContract {
  return {
    requestMode: 'claude-print',
    transport: 'stdin-text',
    model: config.model ?? null,
    stream: {
      outputFormat: 'stream-json',
      includePartialMessages: true,
      expectedEvents: [
        'system:init',
        'stream_event:content_block_delta',
        'assistant:snapshot',
        'result',
      ],
    },
    permissions: {
      permissionMode: 'plan',
      settingSources: 'local',
      slashCommands: 'disabled',
      sessionPersistence: false,
    },
    tools: {
      policy: 'read-only',
      tools: [...READ_ONLY_CLAUDE_TOOLS],
      allowedTools: [...READ_ONLY_CLAUDE_TOOLS],
      strictMcpConfig: true,
      mcpBridge: 'offline-replay-plus-manual-live-gate',
    },
    transcript: {
      mode: 'clean-result-text',
      parseErrorsVisible: true,
      terminalNoiseFiltered: true,
      expectedMarkerRequired: true,
    },
    offlineCoverage: [
      'command-shape',
      'cli-version-probe',
      'stream-json-parser',
      'long-response-partial-fixture-replay',
      'tool-use-fixture-replay',
      'mcp-tool-use-tool-result-fixture-replay',
      'terminal-noise-filtering',
      'expected-marker',
      'auth-quota-runtime-failure-classification',
    ],
    manualLiveGate: {
      requiredFlag: '--manual-claude',
      requiredEnv: 'CODE_AGENT_CLAUDE_CLI_SMOKE=1',
      stillRequires: [
        'logged-in subscription account',
        'quota-available request',
        'live long-response subscription request',
        'live MCP bridge tool execution',
      ],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseClaudeSubscriptionSmokeLine(line: string): ClaudeSubscriptionParsedEvent | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: `parse_error: ${line.slice(0, 120)}` };
  }
  if (!isRecord(parsed)) return null;

  const type = typeof parsed.type === 'string' ? parsed.type : undefined;
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined;
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;

  if (type === 'system') {
    return { type, subtype, sessionId };
  }

  if (type === 'stream_event' && isRecord(parsed.event)) {
    const event = parsed.event;
    const contentBlock = isRecord(event.content_block) ? event.content_block : undefined;
    const toolName = contentBlock?.type === 'tool_use' && typeof contentBlock.name === 'string'
      ? contentBlock.name
      : undefined;
    if (event.type === 'content_block_delta' && isRecord(event.delta) && typeof event.delta.text === 'string') {
      return { type, textDelta: event.delta.text, toolName, sessionId };
    }
    return { type, toolName, sessionId };
  }

  if ((type === 'assistant' || type === 'user') && isRecord(parsed.message) && Array.isArray(parsed.message.content)) {
    let textDelta = '';
    let toolName: string | undefined;
    let toolResult = false;
    for (const item of parsed.message.content) {
      if (!isRecord(item)) continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        textDelta += item.text;
      }
      if (item.type === 'tool_use' && typeof item.name === 'string') {
        toolName = item.name;
      }
      if (item.type === 'tool_result') {
        toolResult = true;
      }
    }
    return { type, textDelta: textDelta || undefined, toolName, ...(toolResult ? { toolResult } : {}), sessionId };
  }

  if (type === 'result') {
    const finalText = typeof parsed.result === 'string' ? parsed.result : undefined;
    const isError = parsed.is_error === true;
    const statusCode = firstNumber(
      parsed.api_error_status,
      parsed.statusCode,
      isRecord(parsed.error) ? parsed.error.status : undefined,
      isRecord(parsed.error) ? parsed.error.statusCode : undefined,
    );
    return {
      type,
      subtype,
      finalText,
      error: isError ? finalText || 'Claude result reported is_error=true' : undefined,
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      sessionId,
    };
  }

  return { type, subtype, sessionId };
}

export function parseClaudeSubscriptionSmokeOutput(args: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  expectedText: string;
  occurredAt?: number;
}): ClaudeSubscriptionSmokeResult {
  const eventCounts = {
    init: 0,
    streamDelta: 0,
    assistantSnapshot: 0,
    toolUse: 0,
    mcpToolUse: 0,
    toolResult: 0,
    result: 0,
    parseError: 0,
  };
  let finalText = '';
  let streamedText = '';
  let cliErrorText = '';
  let cliErrorStatusCode: number | undefined;
  let externalSessionId: string | undefined;

  for (const line of args.stdout.split(/\r?\n/)) {
    const event = parseClaudeSubscriptionSmokeLine(line);
    if (!event) continue;
    if (event.error?.startsWith('parse_error:')) {
      eventCounts.parseError += 1;
      continue;
    }
    if (event.sessionId) externalSessionId = event.sessionId;
    if (event.type === 'system' && event.subtype === 'init') eventCounts.init += 1;
    if (event.type === 'stream_event' && event.textDelta) {
      eventCounts.streamDelta += 1;
      streamedText += event.textDelta;
    }
    if (event.type === 'assistant' && event.textDelta) {
      eventCounts.assistantSnapshot += 1;
    }
    if (event.toolName) {
      eventCounts.toolUse += 1;
      if (event.toolName.startsWith('mcp__')) eventCounts.mcpToolUse += 1;
    }
    if (event.toolResult) eventCounts.toolResult += 1;
    if (event.type === 'result') {
      eventCounts.result += 1;
      if (event.finalText) finalText = event.finalText;
      if (event.error) {
        cliErrorText = event.error;
        if (typeof event.statusCode === 'number') {
          cliErrorStatusCode = event.statusCode;
        }
      }
    }
  }

  const resolvedFinalText = finalText || streamedText;
  const failureMessage = cliErrorText || args.stderr.trim() || (
    args.exitCode && args.exitCode !== 0 ? `Claude CLI exited with code ${args.exitCode}` : ''
  );
  if (failureMessage || args.exitCode !== 0) {
    return {
      ok: false,
      status: 'blocked',
      finalText: resolvedFinalText || undefined,
      externalSessionId,
      eventCounts,
      failure: classifyAgentEngineFailure({
        engine: 'claude_code',
        message: failureMessage || 'Claude CLI failed without stderr.',
        exitCode: args.exitCode,
        statusCode: cliErrorStatusCode,
        occurredAt: args.occurredAt,
      }),
    };
  }

  if (!resolvedFinalText.includes(args.expectedText)) {
    return {
      ok: false,
      status: 'failed',
      finalText: resolvedFinalText || undefined,
      externalSessionId,
      eventCounts,
      failure: classifyAgentEngineFailure({
        engine: 'claude_code',
        message: `Claude CLI completed but final output did not include expected marker: ${args.expectedText}`,
        exitCode: args.exitCode,
        occurredAt: args.occurredAt,
      }),
    };
  }

  return {
    ok: true,
    status: 'passed',
    finalText: resolvedFinalText,
    externalSessionId,
    eventCounts,
  };
}

const TRANSCRIPT_NOISE_PATTERNS = [
  /terminal footer/i,
  /interface clutter/i,
  /tokens used/i,
  /tool result/i,
  /press .+ to continue/i,
] as const;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function containsTranscriptNoise(text: string): boolean {
  return TRANSCRIPT_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function replayClaudeSubscriptionSmokeFixture(args: {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  expectedText: string;
  requireToolUse?: boolean;
  expectMcpBridge?: boolean;
  source?: string;
  occurredAt?: number;
}): ClaudeSubscriptionFixtureReplayResult {
  const result = parseClaudeSubscriptionSmokeOutput({
    stdout: args.stdout,
    stderr: args.stderr ?? '',
    exitCode: args.exitCode ?? 0,
    expectedText: args.expectedText,
    occurredAt: args.occurredAt,
  });
  const finalText = result.finalText ?? '';
  const replay: ClaudeSubscriptionFixtureReplayEvidence = {
    mode: 'stream-json-fixture',
    source: args.source ?? null,
    observed: {
      streamDelta: result.eventCounts.streamDelta,
      assistantSnapshot: result.eventCounts.assistantSnapshot,
      toolUse: result.eventCounts.toolUse,
      mcpToolUse: result.eventCounts.mcpToolUse,
      toolResult: result.eventCounts.toolResult,
      result: result.eventCounts.result,
      parseError: result.eventCounts.parseError,
    },
    requirements: {
      requireToolUse: args.requireToolUse === true,
      requireMcpBridge: args.expectMcpBridge === true,
    },
    checks: {
      expectedMarkerFound: finalText.includes(args.expectedText),
      partialDeltasReassembled: result.eventCounts.streamDelta >= 2 && finalText.includes(args.expectedText),
      assistantSnapshotNotDuplicated: result.eventCounts.assistantSnapshot > 0
        && countOccurrences(finalText, args.expectedText) === 1,
      terminalNoiseFiltered: result.eventCounts.parseError > 0 && !containsTranscriptNoise(finalText),
      requiredToolUseObserved: args.requireToolUse !== true || result.eventCounts.toolUse > 0,
      requiredMcpToolUseObserved: args.expectMcpBridge !== true || result.eventCounts.mcpToolUse > 0,
      requiredToolResultObserved: args.expectMcpBridge !== true || result.eventCounts.toolResult > 0,
      resultEventObserved: result.eventCounts.result > 0,
    },
    failedChecks: [],
  };
  replay.failedChecks = Object.entries(replay.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  if (result.ok && replay.failedChecks.length > 0) {
    return {
      ...result,
      ok: false,
      status: 'failed',
      replay,
      failure: classifyAgentEngineFailure({
        engine: 'claude_code',
        message: `Claude subscription fixture replay failed checks: ${replay.failedChecks.join(', ')}`,
        exitCode: args.exitCode ?? 0,
        occurredAt: args.occurredAt,
      }),
    };
  }

  return { ...result, replay };
}

function runProcess(args: {
  binary: string;
  commandArgs: string[];
  stdin?: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.binary, args.commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000).unref?.();
    }, args.timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin.end(args.stdin ?? '');
  });
}

export function validateClaudeSubscriptionSmokeGate(args: {
  manualClaude: boolean;
  env?: Pick<NodeJS.ProcessEnv, 'CODE_AGENT_CLAUDE_CLI_SMOKE'>;
}): void {
  if (!args.manualClaude) {
    throw new Error('Claude subscription smoke is manual-only. Pass --manual-claude to acknowledge a real Claude CLI request.');
  }
  if (args.env?.CODE_AGENT_CLAUDE_CLI_SMOKE !== '1') {
    throw new Error('Claude subscription smoke requires CODE_AGENT_CLAUDE_CLI_SMOKE=1.');
  }
}

async function probeVersion(binary: string): Promise<string> {
  const result = await runProcess({
    binary,
    commandArgs: ['--version'],
    timeoutMs: 10_000,
  });
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/).find(Boolean);
  if (result.exitCode !== 0 || !version) {
    throw new Error(`Claude CLI version probe failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  return version;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (hasFlag(parsed, 'help')) {
    usage();
    return;
  }

  const json = hasFlag(parsed, 'json');
  const dryRun = hasFlag(parsed, 'dry-run');
  const probeOnly = hasFlag(parsed, 'probe-only');
  const manualClaude = hasFlag(parsed, 'manual-claude');
  const replayFixture = getStringOption(parsed, 'replay-fixture');
  const requireToolUse = hasFlag(parsed, 'require-tool-use');
  const expectMcpBridge = hasFlag(parsed, 'expect-mcp-bridge');
  const config: ClaudeSubscriptionSmokeConfig = {
    binary: getStringOption(parsed, 'binary') ?? 'claude',
    model: getStringOption(parsed, 'model'),
    prompt: getStringOption(parsed, 'prompt') ?? 'Reply with exactly: ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
    expectedText: getStringOption(parsed, 'expected') ?? 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
    timeoutMs: getNumberOption(parsed, 'timeout-ms') ?? 45_000,
  };
  const commandArgs = buildClaudeSubscriptionSmokeArgs(config);
  const contract = buildClaudeSubscriptionSmokeContract(config);

  if (replayFixture) {
    const fixtureStdout = await fs.readFile(replayFixture, 'utf8');
    const result = {
      ...replayClaudeSubscriptionSmokeFixture({
        stdout: fixtureStdout,
        expectedText: config.expectedText,
        requireToolUse: requireToolUse || expectMcpBridge,
        expectMcpBridge,
        source: replayFixture,
        occurredAt: Date.now(),
      }),
      contract,
    };
    if (json) printJson(result);
    else printKeyValue('Claude subscription CLI fixture replay', [
      ['status', result.status],
      ['fixture', replayFixture],
      ['finalText', result.finalText],
      ['streamDelta', result.replay.observed.streamDelta],
      ['assistantSnapshot', result.replay.observed.assistantSnapshot],
      ['toolUse', result.replay.observed.toolUse],
      ['mcpToolUse', result.replay.observed.mcpToolUse],
      ['toolResult', result.replay.observed.toolResult],
      ['parseError', result.replay.observed.parseError],
      ['failedChecks', result.replay.failedChecks.join(', ') || null],
      ['failure', result.failure ? `${result.failure.category}/${result.failure.reason}` : null],
    ]);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (dryRun) {
    const output = {
      ok: true,
      dryRun: true,
      binary: config.binary,
      command: [config.binary, ...commandArgs].join(' '),
      prompt: config.prompt,
      expectedText: config.expectedText,
      timeoutMs: config.timeoutMs,
      contract,
      requiredFlag: '--manual-claude',
      requiredEnv: 'CODE_AGENT_CLAUDE_CLI_SMOKE=1',
      validates: [
        'Claude CLI version probe',
        'pipe-based claude -p stdin prompt',
        'stream-json output with input-format text',
        'offline long-response partial replay with terminal noise filtering',
        'offline mcp__ tool_use/tool_result replay for MCP bridge boundary',
        'final result contains expected marker',
        'auth/quota/runtime failures are classified instead of treated as pass',
      ],
    };
    if (json) printJson(output);
    else {
      console.log('Claude subscription CLI smoke dry run passed');
      printJson(output);
    }
    return;
  }

  const version = await probeVersion(config.binary);
  if (probeOnly) {
    const output = { ok: true, probeOnly: true, version, contract };
    if (json) printJson(output);
    else printKeyValue('Claude subscription CLI probe', [['version', version]]);
    return;
  }

  validateClaudeSubscriptionSmokeGate({ manualClaude, env: process.env });

  const run = await runProcess({
    binary: config.binary,
    commandArgs,
    stdin: config.prompt,
    timeoutMs: config.timeoutMs,
  });
  const result = {
    ...parseClaudeSubscriptionSmokeOutput({
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      expectedText: config.expectedText,
      occurredAt: Date.now(),
    }),
    version,
    contract,
  };

  if (json) printJson(result);
  else printKeyValue('Claude subscription CLI smoke', [
    ['status', result.status],
    ['version', result.version],
    ['session', result.externalSessionId],
    ['finalText', result.finalText],
    ['failure', result.failure ? `${result.failure.category}/${result.failure.reason}` : null],
    ['suggestion', result.failure?.suggestion],
  ]);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => finishWithError(error));
}
