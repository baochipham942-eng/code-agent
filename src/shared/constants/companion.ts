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
const MAX_FRAME_BYTES = 65_535;
const MAX_REQUEST_RECORDS = 32;
/** relay WS 层入站上限在 schema 密文上限之上的信封 JSON 余量。 */
const RELAY_WIRE_HEADROOM_BYTES = 2_048;

/** Apple Push endpoint hosts. Selected by NEO_APNS_ENV at provider start. */
export const COMPANION_APNS = {
  productionAuthority: 'https://api.push.apple.com',
  sandboxAuthority: 'https://api.sandbox.push.apple.com',
  pathPrefix: '/3/device/',
  pushType: 'alert',
  /** APNs device token is 32 bytes, written as 64 hex characters. */
  deviceTokenHexLength: 64,
} as const;

export const COMPANION_LIMITS = {
  idLength: 128,
  messageLength: 32_000,
  syncPageSize: 100,
  librarySessionLimit: 500,
  historyByteLimit: 512_000,
  historyMessageCharacters: 64_000,
  /** VirtualHistory fixture window; per-session offline history cache cap. */
  historyWindowMessages: 1000,
  /** Total on-device conversation cache across sessions (message text + tool cards). */
  historyCacheQuotaBytes: 16 * 1024 * 1024,
  maxScopeSessions: 32,
  requestTimeoutMs: 10_000,
  invitationTtlMs: 120_000,
  handshakeTtlMs: 15_000,
  channelTtlMs: 300_000,
  maxChannels: 32,
  maxHandshakes: 8,
  maxFrames: 10_000,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxPayloadBytes: 60_000,
  maxMessageRecords: 64,
  maxRequestRecords: MAX_REQUEST_RECORDS,
  voiceBase64Limit: 1_800_000,
  /** One PCM16 16 kHz mono frame over Noise; ~1s of audio. Host rejects larger. */
  voicePcmBase64Limit: 48_000,
  /** Must match GUMMY_REALTIME_SAMPLE_RATE; pinned by tests/unit/mobile/realtimeDictation.test.ts. */
  voicePcmSampleRate: 16_000,
  voiceDurationMs: 60_000,
  /** 录音期间每隔这么久切一段传一段：短了 whisper 认不准（<2s 明显变差），长了草稿追加得太慢。 */
  voiceChunkMs: 4_000,
  pollIntervalMs: 1_000,
  /** 有命令在飞时的轮询间隔：结算回执只能靠轮询取回，1 秒一拍等于每段转写白等半秒。 */
  pendingPollIntervalMs: 250,
  /**
   * 手机项目/会话 sheet 等「电脑里的库」读回的最长等待（2026-09-14 build 34 反馈③）：
   * 底层 request 没有客户端超时，连接僵死时 UI 会无限转圈；到点落「连不上电脑」失败态。
   */
  librarySheetWaitMs: 8_000,
  /**
   * 「正在核对电脑是否已接收」这句在发出命令后憋多久才说（N-MOBILE-PENDING-NOISE）。
   * 那句话是防重复发送的**异常**兜底语，正常路径上 ack 几十毫秒就回来，每发一条都闪一下
   * 等于每次都提醒用户「别乱点」（爸 2026-09-16 build 43 真机）。低于这个阈值就闭嘴。
   */
  pendingNoticeDelayMs: 3_000,
  /**
   * 前台轻提示的驻留时长（N-MOBILE-FOREGROUND-PUSH）：系统横幅退场后，会话区顶部的轻提示
   * 到点自隐；错过了也不丢——抽屉会话行上的未读点还在。UI 层（MobileRoot）消费，同
   * pendingNoticeDelayMs 的先例：呈现节奏不放 store。
   */
  foregroundAlertAutoHideMs: 5_000,
  /**
   * 单次 mDNS 重解析的超时（fix4-⑤）：到点即回退绑定里的旧地址，别把重连卡在 DNS 上。
   * 原生两侧（NeoLanDnsPlugin / LanDnsPlugin）由 JS 传参消费，这里是唯一真源。
   */
  mdnsResolveTimeoutMs: 3_000,
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
  /** Tiny uploads finish in one poll; keep preparing/transferring visible at least this long. */
  attachChipMinVisibleMs: 400,
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
  /** APNs provider JWT lifetime; Apple accepts iat within one hour. */
  pushJwtTtlMs: 50 * 60 * 1000,
  /** Host dial-out relay: absent/disabled config must not change LAN behavior. */
  relayConfigFile: 'companion-relay.json',
  /** Host 数据目录下的设备票据文件（N-COMPANION-RELAY-DEVICE-TICKET），与 relayConfigFile 同目录。 */
  relayTicketFile: 'companion-relay-ticket.json',
  /** relay 设备票据有效期：账号令牌只在换票时用一次，日常连接全靠票据（不依赖 supabase 可达）。 */
  relayTicketTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** 票据剩余有效期低于该阈值时，relay 在以票据鉴权的连接上下发新票（续签）。 */
  relayTicketRenewBeforeMs: 7 * 24 * 60 * 60 * 1000,
  relayCredentialService: 'dev.neo.companion.relay.v1',
  /** Routing credential TTL; not a long-term content key. */
  relayRouteTokenTtlMs: 60_000,
  relayMaxBufferedFrames: 32,
  relayMaxBufferedBytes: 256 * 1024,
  relayReconnectBackoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  /**
   * 手机前台断线自动重连（N-MOBILE-AUTO-RECONNECT）：第一次立即试，之后按这档
   * 2/4/8/16/30s（±50% 抖动），再之后每 30s，累计 10 分钟后每 60s。后台不跑。
   */
  phoneReconnectBackoffMs: [2_000, 4_000, 8_000, 16_000, 30_000],
  phoneReconnectSteadyMs: 30_000,
  phoneReconnectSlowMs: 60_000,
  phoneReconnectSlowAfterMs: 600_000,
  /**
   * 退后台不立即拆连接（N-MOBILE-BG-KEEPALIVE-GRACE）：宽限这么久才关，覆盖「切出去看一眼
   * 就回来」的量级。必须 < channelTtlMs（300s，LAN 逻辑通道在 Host 侧的寿命），宽限内回前台
   * 连一次握手都省掉；relay 的后台 socket 死活不靠它保——回前台用 sync 探活兜底。
   */
  backgroundKeepaliveGraceMs: 30_000,
  relayHeartbeatMs: 20_000,
  relayIdleMs: 60_000,
  relayConnectTimeoutMs: 10_000,
  /** Host 拨 relay：open 后撑过这么久才清退避计数；更早被关按拨号失败退避（relay 在 upgrade 后才验凭据）。 */
  relayStableConnectionMs: 5_000,
  /** relay 服务端：设备注册到没有 host 的 route 后等这么久，host 仍没来就回 no-host 帧让手机秒级失败。
   * 盖住 Host 重连退避的前两档（1s+2s），更长的 Host 缺席按「电脑不在线」报。 */
  relayNoHostGraceMs: 5_000,
  relaySeqHold: 16,
  relayAuthLength: 16,
  /** companion-relay.json `caFile` path length (absolute or relative to dataDirectory). */
  relayCaFileLength: 4_096,
  /** Extra CA PEM size cap; a typical CA cert is ~1–2 KiB. */
  relayCaPemMaxBytes: 65_536,
  /** relay 服务端：单条 WS 入站帧的字节上限（schema 密文上限 + 信封余量）。 */
  relayMaxWireFrameBytes: MAX_FRAME_BYTES * MAX_REQUEST_RECORDS + RELAY_WIRE_HEADROOM_BYTES,
  /** relay 服务端：并发 route（token）上限，超出的新注册直接丢弃。 */
  relayMaxRoutes: 256,
  /** 单个 Neo 账号在 relay 上最多占的路由数（每台已配对手机 1 条，多台电脑累加）；共享凭据不受此限。 */
  relayMaxRoutesPerAccount: 32,
  /** 所有账号路由合计上限，与共享凭据的 relayMaxRoutes 分开算，账号用户挤不掉旧通道。 */
  relayMaxAccountRoutes: 256,
  /** relay 服务端：过期 route / 空闲连接清扫周期。 */
  relaySweepMs: 15_000,
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
