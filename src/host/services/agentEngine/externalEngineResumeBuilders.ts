import type { AgentEnginePermissionProfile } from '../../../shared/contract/agentEngine';

export interface ExternalEngineResumeIdentity {
  runId: string;
  sessionId: string;
  attempt: number;
  ownerEpoch: number;
  externalSessionId: string;
}

export interface ExternalEngineResumeLaunch extends ExternalEngineResumeIdentity {
  args: string[];
  cwd: string;
  stdin?: string;
  commandSummary: string;
  permissionProfile: 'read_only';
}

interface CommonResumeInput extends ExternalEngineResumeIdentity {
  cwd: string;
  model?: string | null;
  continuationInput?: string;
  permissionProfile?: AgentEnginePermissionProfile;
}

export function buildCodexResumeArgs(input: CommonResumeInput & {
  lastMessagePath: string;
}): string[] {
  assertResumeInput(input);
  return [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    ...(input.model?.trim() ? ['--model', input.model.trim()] : []),
    '--skip-git-repo-check',
    '--output-last-message',
    input.lastMessagePath,
    input.externalSessionId.trim(),
    ...(input.continuationInput !== undefined ? ['-'] : []),
  ];
}

export function createCodexResumeLaunch(input: CommonResumeInput & {
  lastMessagePath: string;
}): ExternalEngineResumeLaunch {
  return {
    ...resumeIdentity(input),
    args: buildCodexResumeArgs(input),
    cwd: input.cwd,
    ...(input.continuationInput !== undefined ? { stdin: input.continuationInput } : {}),
    commandSummary: 'codex exec resume --json -c sandbox_mode=<read-only> [model] [session:<redacted>] [continuation:<redacted>]',
    permissionProfile: 'read_only',
  };
}

export function buildClaudeResumeArgs(input: CommonResumeInput): string[] {
  assertResumeInput(input);
  return [
    '-p',
    '--verbose',
    '--resume',
    input.externalSessionId.trim(),
    ...(input.model?.trim() ? ['--model', input.model.trim()] : []),
    '--safe-mode',
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Glob,Grep,LS',
    '--allowedTools',
    'Read,Glob,Grep,LS',
    '--no-chrome',
    '--strict-mcp-config',
    '--include-partial-messages',
  ];
}

export function createClaudeResumeLaunch(input: CommonResumeInput): ExternalEngineResumeLaunch {
  return {
    ...resumeIdentity(input),
    args: buildClaudeResumeArgs(input),
    cwd: input.cwd,
    ...(input.continuationInput !== undefined ? { stdin: input.continuationInput } : {}),
    commandSummary: 'claude --print --resume [session:<redacted>] --output-format stream-json --permission-mode plan [continuation:<redacted>]',
    permissionProfile: 'read_only',
  };
}

function assertResumeInput(input: CommonResumeInput): void {
  if (!input.runId.trim() || !input.sessionId.trim()) throw new Error('External resume requires logical run and session identity');
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error('External resume requires the recovered attempt');
  if (!Number.isInteger(input.ownerEpoch) || input.ownerEpoch < 1) throw new Error('External resume requires the recovered owner epoch');
  if (!input.externalSessionId.trim()) throw new Error('External resume requires a stable external session id');
  if (!input.cwd.trim()) throw new Error('External resume requires a recovery cwd');
  if ((input.permissionProfile ?? 'read_only') !== 'read_only') {
    throw new Error('External recovery is restricted to the read-only permission profile');
  }
}

function resumeIdentity(input: CommonResumeInput): ExternalEngineResumeIdentity {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    attempt: input.attempt,
    ownerEpoch: input.ownerEpoch,
    externalSessionId: input.externalSessionId.trim(),
  };
}
