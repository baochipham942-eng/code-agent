import * as path from 'node:path';

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

export interface ExternalEngineContinuationLifecycle {
  readonly runId: string;
  readonly attempt: number;
  readonly ownerEpoch: number;
}

interface CommonContinuationInput {
  readonly lifecycle: ExternalEngineContinuationLifecycle;
  readonly sessionId: string;
  readonly persistedExternalSessionId: string;
  readonly cwd: string;
  readonly model?: string | null;
  readonly continuationInput: string;
  readonly permissionProfile?: AgentEnginePermissionProfile;
}

export interface CodexContinuationResumeInput extends CommonContinuationInput {
  /** The same root returned by getLogsPath() for the current process. */
  readonly logsRoot: string;
}

export type ClaudeContinuationResumeInput = CommonContinuationInput;

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

/**
 * Builds a normal second-or-later turn for an already persisted Codex thread.
 * The output file belongs to the new logical run, never to the previous turn.
 */
export function createCodexContinuationResumeLaunch(
  input: CodexContinuationResumeInput,
): ExternalEngineResumeLaunch {
  const common = continuationResumeInput(input);
  const runId = assertPathSafeRunId(input.lifecycle.runId);
  const logsRoot = input.logsRoot.trim();
  if (!logsRoot || !path.isAbsolute(logsRoot)) {
    throw new Error('Codex continuation requires an absolute logs root');
  }
  return createCodexResumeLaunch({
    ...common,
    lastMessagePath: path.join(
      logsRoot,
      'agent-engines',
      'codex-cli',
      `${runId}.last.md`,
    ),
  });
}

/**
 * Builds a normal second-or-later turn for an already persisted Claude
 * session. Claude print mode receives the continuation only through stdin.
 */
export function createClaudeContinuationResumeLaunch(
  input: ClaudeContinuationResumeInput,
): ExternalEngineResumeLaunch {
  return createClaudeResumeLaunch(continuationResumeInput(input));
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

function continuationResumeInput(input: CommonContinuationInput): CommonResumeInput {
  if (!input.continuationInput.trim()) {
    throw new Error('External continuation requires a non-empty turn prompt');
  }
  return {
    runId: input.lifecycle.runId,
    sessionId: input.sessionId,
    attempt: input.lifecycle.attempt,
    ownerEpoch: input.lifecycle.ownerEpoch,
    externalSessionId: input.persistedExternalSessionId,
    cwd: input.cwd,
    model: input.model,
    continuationInput: input.continuationInput,
    permissionProfile: input.permissionProfile,
  };
}

function assertPathSafeRunId(runId: string): string {
  const normalized = runId.trim();
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || path.basename(normalized) !== normalized
  ) {
    throw new Error('Codex continuation run id is not safe for the last-message path');
  }
  return normalized;
}
