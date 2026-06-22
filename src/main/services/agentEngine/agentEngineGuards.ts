import * as fs from 'fs';
import * as path from 'path';
import type { AgentEngineDescriptor, AgentEnginePermissionProfile, AgentEngineSessionMetadata, ExternalAgentEngineKind } from '../../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import type { Session } from '../../../shared/contract/session';

export function assertWorkspaceCwd(cwd: string, workspaceRoot: string): string {
  const resolvedCwd = realpathOrThrow(cwd, 'cwd');
  const resolvedRoot = realpathOrThrow(workspaceRoot, 'workspace root');
  const relative = path.relative(resolvedRoot, resolvedCwd);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedCwd;
  }
  throw new Error(`Agent Engine cwd must stay inside workspace: ${resolvedCwd}`);
}

export function isExternalAgentEngine(
  kind: AgentEngineSessionMetadata['kind'],
): kind is ExternalAgentEngineKind {
  return kind === 'codex_cli' || kind === 'claude_code' || kind === 'mimo_code' || kind === 'kimi_code';
}

export function assertReadOnlyExternalProfile(
  profile: AgentEnginePermissionProfile | undefined,
): 'read_only' {
  if (profile && profile !== 'read_only') {
    throw new Error('External Agent Engine execution is read-only in this release.');
  }
  return 'read_only';
}

export function assertExternalEngineSessionAllowed(
  session: Session | null | undefined,
): asserts session is Session {
  if (!session) {
    throw new Error('Session not found for Agent Engine execution.');
  }
  if ((session.type ?? 'chat') !== 'chat') {
    throw new Error('External Agent Engine execution is only allowed for chat sessions.');
  }
  if (session.readOnly) {
    throw new Error('External Agent Engine execution is not allowed in read-only sessions.');
  }
  const origin = session.origin?.kind ?? 'manual';
  if (origin !== 'manual') {
    throw new Error(`External Agent Engine execution is not allowed for ${origin} sessions.`);
  }
}

export function buildManualAgentEngineSelection(
  session: Session | null | undefined,
  descriptor: AgentEngineDescriptor,
  profile?: AgentEnginePermissionProfile,
  model?: string | null,
  now: number = Date.now(),
): AgentEngineSessionMetadata {
  if (descriptor.kind === 'native') {
    return normalizeAgentEngineSession({
      kind: 'native',
      permissionProfile: 'default',
      origin: 'manual',
      updatedAt: now,
    });
  }

  assertExternalEngineSessionAllowed(session);

  if (!descriptor.executable || descriptor.installState !== 'installed') {
    throw new Error(descriptor.lastError || `${descriptor.label} is not installed or executable.`);
  }

  const permissionProfile = assertReadOnlyExternalProfile(profile ?? descriptor.defaultPermissionProfile);
  const workspaceRoot = session.workingDirectory?.trim();
  if (!workspaceRoot) {
    throw new Error(`${descriptor.label} requires a session workspace before it can run.`);
  }

  const cwd = assertWorkspaceCwd(workspaceRoot, workspaceRoot);
  return normalizeAgentEngineSession({
    kind: descriptor.kind,
    ...(model?.trim() ? { model: model.trim() } : {}),
    cwd,
    permissionProfile,
    origin: 'manual',
    updatedAt: now,
  });
}

export function resolveExternalEngineLaunch(
  session: Session | null | undefined,
  engine: AgentEngineSessionMetadata,
  requestedCwd?: string | null,
): { cwd: string; workspaceRoot: string; permissionProfile: 'read_only'; model?: string } {
  assertExternalEngineSessionAllowed(session);

  if (!isExternalAgentEngine(engine.kind)) {
    throw new Error('Native Agent Engine does not require external launch policy.');
  }
  if (engine.origin && engine.origin !== 'manual') {
    throw new Error('External Agent Engine execution requires manual engine selection.');
  }

  const permissionProfile = assertReadOnlyExternalProfile(engine.permissionProfile);
  const workspaceRoot = session.workingDirectory?.trim();
  if (!workspaceRoot) {
    throw new Error('External Agent Engine requires a selected workspace root.');
  }

  if (engine.cwd) {
    assertWorkspaceCwd(engine.cwd, workspaceRoot);
  }

  const cwd = assertWorkspaceCwd(requestedCwd?.trim() || engine.cwd || workspaceRoot, workspaceRoot);
  return {
    cwd,
    workspaceRoot: assertWorkspaceCwd(workspaceRoot, workspaceRoot),
    permissionProfile,
    ...(engine.model ? { model: engine.model } : {}),
  };
}

function realpathOrThrow(input: string, label: string): string {
  try {
    return fs.realpathSync(path.resolve(input));
  } catch {
    throw new Error(`Agent Engine ${label} must exist: ${input}`);
  }
}
