/** Bounds for the companion's device-scoped protocol. */
export const COMPANION_MANAGE_CHANNEL = 'companion:manage';
/** Stand-in for an event too large to fit one frame; the original payload is never delivered. */
export const COMPANION_EVENT_DROPPED = 'event_dropped';
export const COMPANION_LIMITS = {
  idLength: 128,
  messageLength: 32_000,
  syncPageSize: 100,
  librarySessionLimit: 500,
  historyByteLimit: 512_000,
  historyMessageCharacters: 64_000,
  maxScopeSessions: 32,
  requestTimeoutMs: 10_000,
  invitationTtlMs: 120_000,
  handshakeTtlMs: 15_000,
  channelTtlMs: 300_000,
  maxChannels: 32,
  maxHandshakes: 8,
  maxFrames: 10_000,
  maxFrameBytes: 65_535,
  maxPayloadBytes: 60_000,
  maxMessageRecords: 64,
  maxRequestRecords: 32,
  voiceBase64Limit: 1_800_000,
  voiceDurationMs: 60_000,
  pollIntervalMs: 1_000,
  uiPresenceTtlMs: 15_000,
  lanPort: 8182,
  approvalPreviewLength: 16_000,
} as const;
