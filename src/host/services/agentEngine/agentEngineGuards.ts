import * as fs from 'fs';
import * as path from 'path';
import type { AgentEngineCapability, AgentEngineDescriptor, AgentEnginePermissionProfile, AgentEngineSessionMetadata, ExternalAgentEngineKind } from '../../../shared/contract/agentEngine';
import { AgentEngineCapabilityError, normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import type { Session } from '../../../shared/contract/session';
import type { WorkspaceScope } from '../../../shared/contract/project';
import { getExternalEngineManifestForKind, isManifestBackedExternalKind } from '../../../shared/externalEngineManifest';
import { resolveWorkspacePath } from '../../runtime/workspaceScope';
import { createLogger } from '../infra/logger';
import { isAgentWorktreePath } from '../../agent/agentWorktreePath';

const logger = createLogger('AgentEngineGuards');

export function assertAgentEngineCapability(
  engine: AgentEngineSessionMetadata['kind'],
  capabilities: readonly AgentEngineCapability[] | undefined,
  capability: AgentEngineCapability,
): void {
  const declaredCapabilities = capabilities ?? getExternalEngineManifestForKind(engine)?.capabilities ?? [];
  if (declaredCapabilities.includes(capability)) return;
  const error = new AgentEngineCapabilityError(engine, capability);
  logger.warn('agent engine operation blocked by capability manifest', {
    code: error.code,
    engine,
    capability,
  });
  throw error;
}

export function assertAgentEngineManifestCapability(
  engine: AgentEngineSessionMetadata['kind'],
  capability: AgentEngineCapability,
): void {
  const capabilities = getExternalEngineManifestForKind(engine)?.capabilities ?? [];
  assertAgentEngineCapability(engine, capabilities, capability);
}

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
  return isManifestBackedExternalKind(kind);
}

export function assertReadOnlyExternalProfile(
  profile: AgentEnginePermissionProfile | undefined,
): 'read_only' {
  if (profile && profile !== 'read_only') {
    throw new Error('External Agent Engine execution is read-only in this release.');
  }
  return 'read_only';
}

/**
 * 该引擎是否走 ACP transport。
 *
 * 判据取 manifest 的 `adapter.transport`，**不是引擎名字清单**——按名字枚举的清单
 * 每加一家新引擎就漏一次（N-INJGUARD-BROWSER 那次实付）。新引擎只要在 manifest 里
 * 声明 transport:'acp'，这里自动认得。
 */
function isAcpTransportEngine(kind: AgentEngineSessionMetadata['kind']): boolean {
  return getExternalEngineManifestForKind(kind)?.adapter.transport === 'acp';
}

/**
 * 外部引擎的权限画像闸，按 transport 分两套：
 *
 * - CLI 系（7 家）：维持 read_only。它们把工具执行留在自己进程里，Neo 看不见也拦不住，
 *   唯一安全的姿势就是不给写权限。
 * - ACP 系：放开到 workspace_write。**这不是把闸门拆了，是把闸门挪到了能拦住的地方**——
 *   ACP agent 不自己执行副作用，写文件/跑命令全反向委托回 Neo 的 client 侧方法
 *   （2026-08-27 Kimi 0.38.0 抓包实证），每一次都由 acpClientHostBridge 过 Neo 现有审批链。
 *   read_only 在这条路上换不来安全，只换来「装好没接电」。
 */
export function assertExternalEngineProfile(
  kind: AgentEngineSessionMetadata['kind'],
  profile: AgentEnginePermissionProfile | undefined,
): AgentEnginePermissionProfile {
  if (isAcpTransportEngine(kind)) {
    return profile ?? 'workspace_write';
  }
  return assertReadOnlyExternalProfile(profile);
}

export function assertExternalSubagentProfile(
  profile: AgentEnginePermissionProfile | undefined,
  input: { origin: 'subagent'; cwd: string },
): 'read_only' | 'workspace_write' {
  if (!profile || profile === 'read_only') return 'read_only';
  if (profile === 'workspace_write' && isAgentWorktreePath(input.cwd)) {
    return 'workspace_write';
  }
  if (profile === 'workspace_write') {
    throw new Error('External subagent workspace write is only allowed inside a Neo-managed worktree.');
  }
  throw new Error('External subagent permission profile must be read_only or workspace_write.');
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

  if (descriptor.installState !== 'installed') {
    throw new Error(descriptor.lastError || `${descriptor.label} is not installed or executable.`);
  }
  assertAgentEngineCapability(descriptor.kind, descriptor.capabilities, 'execute');
  if (!descriptor.executable) {
    throw new Error(descriptor.lastError || `${descriptor.label} is not executable.`);
  }

  const permissionProfile = assertExternalEngineProfile(descriptor.kind, profile ?? descriptor.defaultPermissionProfile);
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
  workspaceScope?: WorkspaceScope,
): { cwd: string; workspaceRoot: string; permissionProfile: AgentEnginePermissionProfile; model?: string } {
  assertExternalEngineSessionAllowed(session);

  if (!isExternalAgentEngine(engine.kind)) {
    throw new Error('Native Agent Engine does not require external launch policy.');
  }
  if (engine.origin && engine.origin !== 'manual') {
    throw new Error('External Agent Engine execution requires manual engine selection.');
  }

  const permissionProfile = assertExternalEngineProfile(engine.kind, engine.permissionProfile);
  if (workspaceScope && workspaceScope.roots.length > 1) {
    throw new Error(
      `${engine.kind} cannot safely express this Project's multiple Source roots. `
      + 'Switch to Neo or remove Additional Sources before starting a new external Engine run.',
    );
  }
  const workspaceRoot = workspaceScope?.primaryRoot ?? session.workingDirectory?.trim();
  if (!workspaceRoot) {
    throw new Error('External Agent Engine requires a selected workspace root.');
  }

  if (engine.cwd) {
    assertWorkspaceCwd(engine.cwd, workspaceRoot);
  }

  const requested = requestedCwd?.trim() || engine.cwd || workspaceRoot;
  const cwd = workspaceScope
    ? (resolveWorkspacePath(workspaceScope, requested, 'read')?.canonicalPath
      ?? (() => { throw new Error(`Agent Engine cwd must stay inside Project Sources: ${requested}`); })())
    : assertWorkspaceCwd(requested, workspaceRoot);
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
