// ============================================================================
// Agent Engine Contract
// ============================================================================

import type { ModelCapability } from './model';

export type AgentEngineKind = 'native' | 'codex_cli' | 'claude_code' | 'mimo_code' | 'kimi_code';

export type ExternalAgentEngineKind = Exclude<AgentEngineKind, 'native'>;

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

export type AgentEngineCliStatus = 'available' | 'missing' | 'error' | 'not_checked';
export type AgentEngineAuthState = 'not_checked' | 'authenticated' | 'needs_login' | 'unknown';
export type AgentEngineQuotaState = 'not_checked' | 'available' | 'limited' | 'exhausted' | 'unknown';
export type AgentEngineStreamingMode = 'stream_json' | 'json' | 'text' | 'none' | 'unknown';
export type AgentEngineToolSupport = 'none' | 'read_only_cli_tools' | 'workspace_tools' | 'mcp_bridge' | 'unknown';
export type AgentEngineTranscriptMode = 'clean_stream_json' | 'raw_terminal' | 'session_import' | 'unknown';

export type AgentEngineFailureCategory =
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'permission'
  | 'missing_cli'
  | 'runtime'
  | 'unknown';

export interface AgentEngineReliability {
  cliStatus: AgentEngineCliStatus;
  authState: AgentEngineAuthState;
  quotaState: AgentEngineQuotaState;
  streamingMode: AgentEngineStreamingMode;
  toolSupport: AgentEngineToolSupport;
  transcriptMode: AgentEngineTranscriptMode;
  partialMessages?: boolean;
  mcpBridge?: boolean;
  notes?: string[];
}

export interface AgentEngineFailureDiagnostics {
  category: AgentEngineFailureCategory;
  reason: string;
  message: string;
  suggestion: string;
  retryable: boolean;
  occurredAt?: number;
  statusCode?: number;
  exitCode?: number | null;
  reliability?: Partial<Pick<AgentEngineReliability, 'authState' | 'quotaState' | 'cliStatus'>>;
}

export interface AgentEngineSessionMetadata {
  kind: AgentEngineKind;
  model?: string;
  runId?: string;
  externalSessionId?: string;
  logPath?: string;
  cwd?: string;
  permissionProfile?: AgentEnginePermissionProfile;
  origin?: AgentEngineSessionOrigin;
  updatedAt?: number;
  failure?: AgentEngineFailureDiagnostics;
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
  reliability?: AgentEngineReliability;
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
  model?: string;
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
  failure?: AgentEngineFailureDiagnostics;
}

export interface AgentEngineModelCatalogModel {
  id: string;
  label: string;
  capabilities: ModelCapability[];
  recommended?: boolean;
  disabledReason?: string;
  updatedAt?: string;
}

export interface AgentEngineModelCatalogEngine {
  kind: ExternalAgentEngineKind;
  defaultModel: string;
  models: AgentEngineModelCatalogModel[];
  updatedAt?: string;
}

export interface AgentEngineModelCatalog {
  version: string;
  updatedAt: string;
  engines: AgentEngineModelCatalogEngine[];
}

export type AgentEngineModelCatalogSource = 'remote' | 'bundled';

export interface AgentEngineModelCatalogDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
}

export interface AgentEngineModelCatalogResult {
  catalog: AgentEngineModelCatalog;
  source: AgentEngineModelCatalogSource;
  diagnostics: AgentEngineModelCatalogDiagnostic[];
  contentHash?: string;
  keyId?: string;
  expiresAt?: string;
}

export const AGENT_ENGINE_KINDS: AgentEngineKind[] = ['native', 'codex_cli', 'claude_code', 'mimo_code', 'kimi_code'];

export const DEFAULT_AGENT_ENGINE_SESSION: AgentEngineSessionMetadata = {
  kind: 'native',
  permissionProfile: 'default',
  origin: 'manual',
};

export function isAgentEngineKind(value: unknown): value is AgentEngineKind {
  return typeof value === 'string' && (AGENT_ENGINE_KINDS as string[]).includes(value);
}

const AGENT_ENGINE_FAILURE_CATEGORIES: AgentEngineFailureCategory[] = [
  'auth',
  'quota',
  'timeout',
  'network',
  'permission',
  'missing_cli',
  'runtime',
  'unknown',
];

const AGENT_ENGINE_AUTH_STATES: AgentEngineAuthState[] = [
  'not_checked',
  'authenticated',
  'needs_login',
  'unknown',
];

const AGENT_ENGINE_QUOTA_STATES: AgentEngineQuotaState[] = [
  'not_checked',
  'available',
  'limited',
  'exhausted',
  'unknown',
];

const AGENT_ENGINE_CLI_STATUSES: AgentEngineCliStatus[] = [
  'available',
  'missing',
  'error',
  'not_checked',
];

function normalizeAgentEngineFailureReliability(
  value: unknown,
): AgentEngineFailureDiagnostics['reliability'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  type AgentEngineFailureReliability = NonNullable<AgentEngineFailureDiagnostics['reliability']>;
  const input = value as Partial<AgentEngineFailureReliability>;
  const reliability: AgentEngineFailureReliability = {};
  if (typeof input.authState === 'string' && (AGENT_ENGINE_AUTH_STATES as string[]).includes(input.authState)) {
    reliability.authState = input.authState;
  }
  if (typeof input.quotaState === 'string' && (AGENT_ENGINE_QUOTA_STATES as string[]).includes(input.quotaState)) {
    reliability.quotaState = input.quotaState;
  }
  if (typeof input.cliStatus === 'string' && (AGENT_ENGINE_CLI_STATUSES as string[]).includes(input.cliStatus)) {
    reliability.cliStatus = input.cliStatus;
  }
  return Object.keys(reliability).length > 0 ? reliability : undefined;
}

function normalizeAgentEngineFailureDiagnostics(value: unknown): AgentEngineFailureDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<AgentEngineFailureDiagnostics>;
  if (
    typeof input.category !== 'string'
    || !(AGENT_ENGINE_FAILURE_CATEGORIES as string[]).includes(input.category)
    || typeof input.reason !== 'string'
    || input.reason.trim().length === 0
    || typeof input.message !== 'string'
    || input.message.trim().length === 0
    || typeof input.suggestion !== 'string'
    || input.suggestion.trim().length === 0
  ) {
    return undefined;
  }

  const reliability = normalizeAgentEngineFailureReliability(input.reliability);
  return {
    category: input.category as AgentEngineFailureCategory,
    reason: input.reason,
    message: input.message,
    suggestion: input.suggestion,
    retryable: input.retryable === true,
    ...(typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt) ? { occurredAt: input.occurredAt } : {}),
    ...(typeof input.statusCode === 'number' && Number.isFinite(input.statusCode) ? { statusCode: input.statusCode } : {}),
    ...((typeof input.exitCode === 'number' && Number.isFinite(input.exitCode)) || input.exitCode === null ? { exitCode: input.exitCode } : {}),
    ...(reliability ? { reliability } : {}),
  };
}

export function normalizeAgentEngineSession(value: unknown): AgentEngineSessionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_AGENT_ENGINE_SESSION };
  }

  const input = value as Partial<AgentEngineSessionMetadata>;
  const kind = isAgentEngineKind(input.kind) ? input.kind : 'native';
  const permissionProfile = normalizePermissionProfile(input.permissionProfile, kind);
  const origin = input.origin === 'import' || input.origin === 'external' ? input.origin : 'manual';
  const failure = normalizeAgentEngineFailureDiagnostics(input.failure);

  return {
    kind,
    permissionProfile,
    origin,
    ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
    ...(typeof input.runId === 'string' && input.runId ? { runId: input.runId } : {}),
    ...(typeof input.externalSessionId === 'string' && input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    ...(typeof input.logPath === 'string' && input.logPath ? { logPath: input.logPath } : {}),
    ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
    ...(typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? { updatedAt: input.updatedAt } : {}),
    ...(kind !== 'native' && failure ? { failure } : {}),
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
