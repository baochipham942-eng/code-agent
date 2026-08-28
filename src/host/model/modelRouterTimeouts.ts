// ============================================================================
// Model Router Timeouts
// ============================================================================

function envTimeoutMs(name: string, defaultMs: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

function envDelayMs(name: string, defaultMs: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultMs;
}

// Reasoning-model friendly timeout defaults. All values support same-name env
// overrides so packaged builds do not need to change for provider tuning.
export const ARTIFACT_PROVIDER_TIMEOUT_MS = envTimeoutMs('ARTIFACT_PROVIDER_TIMEOUT_MS', 1_200_000);
export const ARTIFACT_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_FIRST_BYTE_TIMEOUT_MS', 60_000);
export const ARTIFACT_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_INACTIVITY_TIMEOUT_MS', 480_000);
export const ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS', 480_000);
export const ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS', 60_000);
export const ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS', 240_000);
export const ARTIFACT_REPAIR_RETRY_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RETRY_FIRST_BYTE_TIMEOUT_MS', 30_000);
export const ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS', 600_000);
export const ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS', 60_000);
export const ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS', 360_000);
export const ARTIFACT_REPAIR_WRITE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_WRITE_TIMEOUT_MS', 900_000);
export const ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS', 60_000);
export const ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS', 480_000);
export const ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS = [
  envDelayMs('ARTIFACT_SELECTED_PROVIDER_RETRY_DELAY_1_MS', 1_000),
  envDelayMs('ARTIFACT_SELECTED_PROVIDER_RETRY_DELAY_2_MS', 2_500),
];
