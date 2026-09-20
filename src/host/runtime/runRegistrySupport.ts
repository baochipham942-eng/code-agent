import { DURABLE_ACTIVE_SESSION_CONFLICT_CODE } from '../../shared/contract/durableRun';

export function isDurableActiveSessionConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === DURABLE_ACTIVE_SESSION_CONFLICT_CODE) return true;
  return typeof candidate.code === 'string'
    && candidate.code.startsWith('SQLITE_CONSTRAINT')
    && /durable_runs\.session_id|idx_durable_runs_active_session/i.test(String(candidate.message ?? ''));
}

export function isHeartbeatFencingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown };
  return candidate.code === 'RUN_OWNER_FENCED'
    || /heartbeat fenced by stale owner/i.test(candidate.message);
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'));
}

interface NativeAgentTeamProjectionState {
  schemaVersion: 1;
  kind: 'native_with_agent_team_projection';
  nativeState?: unknown;
  teams: Array<{
    teamRunId: string;
    treeId: string;
    operationId: string;
    status: string;
    resultRef?: string;
  }>;
}

export function mergeAgentTeamProjectionState(
  current: unknown,
  team: NativeAgentTeamProjectionState['teams'][number],
): NativeAgentTeamProjectionState {
  const prior = current && typeof current === 'object'
    && (current as { kind?: unknown }).kind === 'native_with_agent_team_projection'
    ? current as NativeAgentTeamProjectionState
    : { schemaVersion: 1 as const, kind: 'native_with_agent_team_projection' as const, nativeState: current, teams: [] };
  return {
    ...prior,
    teams: [...prior.teams.filter((entry) => entry.teamRunId !== team.teamRunId), team],
  };
}

export function asNativeAgentTeamProjectionState(value: unknown): NativeAgentTeamProjectionState | undefined {
  return value && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'native_with_agent_team_projection'
    ? value as NativeAgentTeamProjectionState
    : undefined;
}
