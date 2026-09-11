import { FILE } from './tools';

/** Bounds for the companion's device-scoped protocol. */
export const COMPANION_MANAGE_CHANNEL = 'companion:manage';
/** Stand-in for an event too large to fit one frame; the original payload is never delivered. */
export const COMPANION_EVENT_DROPPED = 'event_dropped';

/** Phone → desktop materials. Size cap is the shared FILE.MAX_SIZE, not a second magic number. */
export const COMPANION_FILE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/zip', 'video/mp4', 'audio/mpeg', 'audio/mp4', 'audio/wav',
] as const;
export type CompanionFileMime = (typeof COMPANION_FILE_MIME_TYPES)[number];

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

const FILE_EXT_MIME: Record<string, CompanionFileMime> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};

export function companionFileMime(name: string, declared: string): CompanionFileMime | null {
  if ((COMPANION_FILE_MIME_TYPES as readonly string[]).includes(declared)) return declared as CompanionFileMime;
  const dot = name.lastIndexOf('.');
  const inferred = dot >= 0 ? FILE_EXT_MIME[name.slice(dot).toLowerCase()] : undefined;
  return inferred ?? null;
}
