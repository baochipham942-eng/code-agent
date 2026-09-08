/** Bounds for the companion's device-scoped protocol. */
export const COMPANION_LIMITS = {
  idLength: 128,
  messageLength: 32_000,
  syncPageSize: 100,
  maxScopeSessions: 32,
  requestTimeoutMs: 10_000,
} as const;
