// ============================================================================
// Agent Engine Contract
// ============================================================================

export type AgentEngineKind = 'native' | 'codex_cli' | 'claude_code';

export type AgentEngineInstallState = 'builtin' | 'installed' | 'missing';

export type AgentEngineRuntimeState =
  | 'ready'
  | 'not_configured'
  | 'blocked'
  | 'error'
  | 'unknown';

export type AgentEngineCapability =
  | 'execute'
  | 'stream_events'
  | 'import_sessions'
  | 'resume'
  | 'review';

export type AgentEnginePermissionProfile =
  | 'default'
  | 'read_only'
  | 'workspace_write';

export type AgentEngineSessionOrigin = 'manual' | 'import' | 'external';

export type AgentEngineCwdPolicy = 'workspace_only';

export type AgentEngineRiskTier = 'low' | 'medium' | 'high';

export interface AgentEngineSessionMetadata {
  kind: AgentEngineKind;
  runId?: string;
  externalSessionId?: string;
  logPath?: string;
  cwd?: string;
  permissionProfile?: AgentEnginePermissionProfile;
  origin?: AgentEngineSessionOrigin;
  updatedAt?: number;
}

export interface AgentEngineDescriptor {
  kind: AgentEngineKind;
  label: string;
  summary: string;
  installState: AgentEngineInstallState;
  runtimeState: AgentEngineRuntimeState;
  executable: boolean;
  command?: string;
  binaryPath?: string;
  version?: string;
  capabilities: AgentEngineCapability[];
  defaultPermissionProfile: AgentEnginePermissionProfile;
  cwdPolicy: AgentEngineCwdPolicy;
  riskTier: AgentEngineRiskTier;
  detectedAt: number;
  lastError?: string;
  auditNotes?: string[];
}

export type AgentEngineEvent =
  | { type: 'text_delta'; runId: string; sessionId: string; text: string; timestamp: number }
  | { type: 'tool_call'; runId: string; sessionId: string; name: string; arguments?: unknown; timestamp: number }
  | {
      type: 'permission_request';
      runId: string;
      sessionId: string;
      requestId: string;
      summary: string;
      timestamp: number;
    }
  | {
      type: 'task_status';
      runId: string;
      sessionId: string;
      status: 'queued' | 'running' | 'stalled' | 'completed' | 'failed' | 'cancelled';
      detail?: string;
      timestamp: number;
    }
  | { type: 'artifact_ref'; runId: string; sessionId: string; path: string; label?: string; timestamp: number }
  | { type: 'done'; runId: string; sessionId: string; exitCode?: number; timestamp: number }
  | { type: 'error'; runId: string; sessionId: string; message: string; timestamp: number };

export interface AgentEngineRunRequest {
  sessionId: string;
  prompt: string;
  cwd: string;
  permissionProfile?: AgentEnginePermissionProfile;
  clientMessageId?: string;
}

export interface AgentEngineRunResult {
  runId: string;
  sessionId: string;
  engine: AgentEngineKind;
  status: 'completed' | 'failed' | 'cancelled';
  outputText?: string;
  logPath?: string;
  exitCode?: number | null;
  error?: string;
}

export const AGENT_ENGINE_KINDS: AgentEngineKind[] = ['native', 'codex_cli', 'claude_code'];

export const DEFAULT_AGENT_ENGINE_SESSION: AgentEngineSessionMetadata = {
  kind: 'native',
  permissionProfile: 'default',
  origin: 'manual',
};

export function isAgentEngineKind(value: unknown): value is AgentEngineKind {
  return typeof value === 'string' && (AGENT_ENGINE_KINDS as string[]).includes(value);
}

export function normalizeAgentEngineSession(value: unknown): AgentEngineSessionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_AGENT_ENGINE_SESSION };
  }

  const input = value as Partial<AgentEngineSessionMetadata>;
  const kind = isAgentEngineKind(input.kind) ? input.kind : 'native';
  const permissionProfile = normalizePermissionProfile(input.permissionProfile, kind);
  const origin = input.origin === 'import' || input.origin === 'external' ? input.origin : 'manual';

  return {
    kind,
    permissionProfile,
    origin,
    ...(typeof input.runId === 'string' && input.runId ? { runId: input.runId } : {}),
    ...(typeof input.externalSessionId === 'string' && input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    ...(typeof input.logPath === 'string' && input.logPath ? { logPath: input.logPath } : {}),
    ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
    ...(typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? { updatedAt: input.updatedAt } : {}),
  };
}

function normalizePermissionProfile(
  value: unknown,
  kind: AgentEngineKind,
): AgentEnginePermissionProfile {
  if (value === 'read_only' || value === 'workspace_write' || value === 'default') {
    return value;
  }
  return kind === 'native' ? 'default' : 'read_only';
}
