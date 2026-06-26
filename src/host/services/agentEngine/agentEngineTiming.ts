export const DEFAULT_CODEX_CLI_STALL_WARNING_MS = 45_000;
export const DEFAULT_CODEX_CLI_TIMEOUT_MS = 10 * 60_000;
export const MIN_CODEX_CLI_TIMEOUT_MS = 10_000;

export interface AgentEngineRunTiming {
  stallWarningMs: number;
  timeoutMs: number;
}

export function normalizeCodexCliRunTiming(input?: Partial<AgentEngineRunTiming>): AgentEngineRunTiming {
  const timeoutMs = normalizePositiveMs(input?.timeoutMs, DEFAULT_CODEX_CLI_TIMEOUT_MS);
  const stallWarningMs = Math.min(
    normalizePositiveMs(input?.stallWarningMs, DEFAULT_CODEX_CLI_STALL_WARNING_MS),
    Math.max(1_000, timeoutMs - 1_000),
  );

  return {
    stallWarningMs,
    timeoutMs: Math.max(timeoutMs, MIN_CODEX_CLI_TIMEOUT_MS),
  };
}

function normalizePositiveMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
