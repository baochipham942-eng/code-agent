import { FILE } from './tools';

/** Bounds for the companion's device-scoped protocol. */
export const COMPANION_MANAGE_CHANNEL = 'companion:manage';
/** Stand-in for an event too large to fit one frame; the original payload is never delivered. */
export const COMPANION_EVENT_DROPPED = 'event_dropped';

/** Phone → desktop materials. Acceptance is extension-authoritative（此表是唯一真源）;
 *  手机选择器的 accept 列表在 packages/mobile/src/platform/fileAccept.ts，由 tests/unit/mobile 的契约测试与真源钉齐。 */
const FILE_EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
} as const;
export type CompanionFileMime = (typeof FILE_EXT_MIME)[keyof typeof FILE_EXT_MIME];

const FILE_CHUNK_BYTES = 24 * 1024;

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
  /** Physically delete companion_events older than this; sync must not keep serving them. */
  eventTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Hard cap on companion_events rows; oldest created_at are deleted first. */
  eventMaxRows: 10_000,
  /** Pending commands older than this cannot reasonably still be resolving. */
  reconcilingRecoveryMs: 300_000,
  fileMaxBytes: FILE.MAX_SIZE,
  /** Raw chunk size so base64 + JSON stay inside one Noise payload (≤48 KiB). */
  fileChunkBytes: FILE_CHUNK_BYTES,
  fileChunkBase64Limit: Math.ceil(FILE_CHUNK_BYTES / 3) * 4,
  fileNameLength: 180,
  cacheQuotaBytes: 200 * 1024 * 1024,
  fileRootDir: '.neo-companion',
  fileStagingDir: 'staging',
  fileUploadsDir: 'uploads',
  /** Outbox rows past this age are expired; opening them re-reads the live session. */
  pushTtlMs: 86_400_000,
  pushMaxAttempts: 5,
} as const;

const RETRYABLE_FILE_CODES = new Set([
  'STORAGE_FULL',
  'ATTACHMENT_INCOMPLETE',
  'COMPANION_TRANSFER_INTERRUPTED',
  'COMPANION_INTERRUPTED',
  'COMPANION_CHANNEL_CLOSED',
  'COMPANION_NETWORK_UNAVAILABLE',
]);

export function companionFileRetryable(code: string): boolean {
  return RETRYABLE_FILE_CODES.has(code);
}

export function companionFileMime(name: string, declared: string): CompanionFileMime | null {
  // 扩展名是权威，客户端声明只做一致性校验：payload.exe 声明 image/png 这类伪造必须拒。
  const dot = name.lastIndexOf('.');
  const inferred = dot >= 0 ? (FILE_EXT_MIME as Record<string, CompanionFileMime>)[name.slice(dot).toLowerCase()] : undefined;
  if (!inferred) return null;
  if (declared && declared !== inferred) return null;
  return inferred;
}
