import { homedir } from 'node:os';
import type { AgentEnginePermissionProfile } from '../../../shared/contract/agentEngine';
import { getShellPath } from '../infra/shellEnvironment';
import {
  ClaudeCodeAdapter,
  type ClaudeParsedEvent,
  type ClaudeProtocolCliConfig,
} from './claudeCodeAdapter';

const GROK_CONFIG: ClaudeProtocolCliConfig = {
  kind: 'grok_cli',
  label: 'Grok Build',
  runPrefix: 'grok',
  logSlug: 'grok-build',
  errorCode: 'GROK_CLI_FAILED',
  promptTransport: 'argv',
  buildArgs: buildGrokArgs,
  buildEnv: buildGrokEnv,
  parseJsonLine: parseGrokJsonLine,
  commandSummary: (model) => [
    'grok --no-auto-update -p',
    '--output-format streaming-json',
    '--permission-mode plan',
    '--tools ""',
    '--disable-web-search',
    '--no-subagents',
    '--no-memory',
    '--max-turns 1',
    ...(model ? [`--model ${model}`] : []),
    '<prompt:redacted>',
  ].join(' '),
};

export class GrokCliAdapter extends ClaudeCodeAdapter {
  constructor() {
    super(GROK_CONFIG);
  }
}

export function buildGrokArgs(
  _profile: AgentEnginePermissionProfile,
  model?: string | null,
  prompt?: string,
): string[] {
  if (!prompt?.trim()) {
    throw new Error('Grok Build requires a non-empty prompt.');
  }
  return [
    '--no-auto-update',
    '-p',
    prompt,
    '--output-format',
    'streaming-json',
    '--permission-mode',
    'plan',
    '--tools',
    '',
    '--disable-web-search',
    '--no-subagents',
    '--no-memory',
    '--max-turns',
    '1',
    ...(model?.trim() ? ['--model', model.trim()] : []),
  ];
}

export function parseGrokJsonLine(line: string, _label = 'Grok Build'): ClaudeParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const data = typeof record.data === 'string' ? record.data : undefined;

  if (type === 'text' && data) {
    return { textDelta: data, textDeltaSource: 'stream' };
  }
  if (type === 'thought') {
    return { status: 'reasoning' };
  }
  if (type === 'tool_call') {
    const toolName = typeof record.name === 'string'
      ? record.name
      : typeof record.tool === 'string'
        ? record.tool
        : 'tool';
    return { toolName };
  }
  if (type === 'end') {
    return {
      status: typeof record.stopReason === 'string' ? record.stopReason : 'completed',
      externalSessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    };
  }
  if (type === 'error') {
    return {
      error: typeof record.message === 'string' ? record.message : 'Grok Build returned an error.',
      statusCode: typeof record.statusCode === 'number' ? record.statusCode : undefined,
    };
  }
  return null;
}

export function buildGrokEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'GROK_SANDBOX',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (allowed.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value;
    }
  }
  env.HOME = env.HOME || homedir();
  env.PATH = getShellPath();
  return env;
}
