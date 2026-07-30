import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnginePermissionProfile } from '../../../shared/contract/agentEngine';
import { getShellPath } from '../infra/shellEnvironment';
import {
  ClaudeCodeAdapter,
  type ClaudeProtocolCliConfig,
} from './claudeCodeAdapter';

const CLIENT_DEFAULT_MODEL = 'client_default';

const CODEBUDDY_CONFIG: ClaudeProtocolCliConfig = {
  kind: 'codebuddy_code',
  label: 'WorkBuddy',
  runPrefix: 'workbuddy',
  logSlug: 'workbuddy',
  errorCode: 'WORKBUDDY_FAILED',
  promptTransport: 'argv',
  buildArgs: buildCodeBuddyArgs,
  buildEnv: buildCodeBuddyEnv,
  commandSummary: (model) => [
    'codebuddy -p',
    '--output-format stream-json',
    '--input-format text',
    '--permission-mode plan',
    '--tools ""',
    '--strict-mcp-config',
    '--max-turns 1',
    ...(model && model !== CLIENT_DEFAULT_MODEL ? [`--model ${model}`] : []),
    '<prompt:redacted>',
  ].join(' '),
};

/**
 * CodeBuddy Code and Claude Code expose the same print-mode stream-json event
 * shape. Runtime differences live in this configuration object; the shared
 * adapter owns persistence, normalized events, failure handling, and logging.
 */
export class CodeBuddyCliAdapter extends ClaudeCodeAdapter {
  constructor() {
    super(CODEBUDDY_CONFIG);
  }
}

export function buildCodeBuddyArgs(
  _profile: AgentEnginePermissionProfile,
  model?: string | null,
  prompt?: string,
): string[] {
  if (!prompt?.trim()) {
    throw new Error('WorkBuddy requires a non-empty prompt.');
  }
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--permission-mode',
    'plan',
    '--tools',
    '',
    '--strict-mcp-config',
    '--max-turns',
    '1',
    '--include-partial-messages',
    ...(model?.trim() && model.trim() !== CLIENT_DEFAULT_MODEL
      ? ['--model', model.trim()]
      : []),
    prompt,
  ];
}

export function buildCodeBuddyEnv(): NodeJS.ProcessEnv {
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
  env.CODEBUDDY_CONFIG_DIR = process.env.CODEBUDDY_CONFIG_DIR?.trim()
    || join(env.HOME, '.workbuddy');
  return env;
}
