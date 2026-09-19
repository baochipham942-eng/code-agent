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
  /**
   * 一份邀请里私网字面量候选（candidates）的硬上限。真实多宿主（Wi-Fi+热点+VPN 虚接口+虚拟桥）
   * 远用不完，超出按接口枚举序截断；同时钉住数组形状，别让 candidates 把 2048 字节的二维码预算吃穿。
   */
  invitationMaxCandidates: 8,
  handshakeTtlMs: 15_000,
  channelTtlMs: 300_000,
  maxChannels: 32,
  maxHandshakes: 8,
  /**
   * 日志去重窗容量（ghost commandId、握手拒单键）：FIFO 淘汰最旧。没有上限的话这些 Set
   * 随对端单调增长，且真故障复发后永久不再点名（ai-review R4 Nit 1）。
   */
  logDedupCapacity: 1_024,
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
  /**
   * 近场能量门（N-VOICE-AMBIENT-GATE）。iOS `averagePower` 是 dBFS；PCM RMS 是同一档的
   * 16-bit 等价值（32768 × 10^(dB/20)）；Android `getMaxAmplitude` 是 0–32767 峰值。
   * 低于门限或近场时长不够的段不送转写。原生 / 补丁脚本的字面量由 tests/unit/mobile 钉齐。
   */
  voiceEnergyDb: -40,
  voiceEnergyRms: 328,
  voiceEnergyPeak: 500,
  voiceMinSpeechMs: 280,
  voiceMeterIntervalMs: 100,
  /**
   * Android 录音前台服务的收尾防抖（N-MOBILE-BG-RECORDING）：分段录音每段都 stop→start 一次，
   * 服务若跟着段走，通知每段闪一次、且后台一旦停了就再起不来（Android 12+ 禁止后台
   * startForegroundService）。停服务要等这一小段确认没有下一段要录。
   */
  voiceServiceStopGraceMs: 2_000,
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
  /**
   * 连接级 WS ping/pong 探活周期（N-COMPANION-RELAY-KEEPALIVE）：relay 与 Host 都按它发协议层
   * ping，上一次 ping 后到本次 ping 前仍无 pong/message 才判死——容忍「连续 1 次未答即
   * terminate」，不给二次机会：半开连接多等一个周期只会把故障发现拖到 relayIdleMs 量级，
   * 而正常链路上 loopback/内网 pong 都是毫秒级，一次未答已足够定性。必须 < relayIdleMs，
   * 给 pong 留满一个完整周期：答 pong 的连接 lastSeen 恒新，idle 清扫永远够不到它（无 route
   * 也活得下去，连接活性不绑 route 生命周期）。手机侧不加发送义务——休眠时答不出 pong 被
   * terminate 是正确行为，醒来走既有重拨。
   */
  relayPingMs: 30_000,
  relayConnectTimeoutMs: 10_000,
  /** Host 拨 relay：open 后撑过这么久才清退避计数；更早被关按拨号失败退避（relay 在 upgrade 后才验凭据）。 */
  relayStableConnectionMs: 5_000,
  /** relay 服务端：设备注册到没有 host 的 route 后等这么久，host 仍没来就回 no-host 帧让手机秒级失败。
   * 盖住 Host 重连退避的前两档（1s+2s），更长的 Host 缺席按「电脑不在线」报。 */
  relayNoHostGraceMs: 5_000,
  /**
   * no-host 过渡态（N-MOBILE-NOHOST-WAKING-STATE）：手机经中继拨到 no-host 后不直接落失败页，
   * 先进「等电脑上线」过渡态——每 relayNoHostRedialMs 重拨一次中继；relayNoHostWaitMs 内电脑上线
   * 则直接连上（全程无失败闪态），到点才落回 connectionRelayNoHost 失败页。节拍在 store 层
   * （companionStore），与 relay 侧 relayNoHostGraceMs 互不代办。
   */
  relayNoHostRedialMs: 3_000,
  /** 见 relayNoHostRedialMs；上限盖住 Host 重连退避的头几档（1+2+4+8s）。 */
  relayNoHostWaitMs: 15_000,
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
  /** 手机登录 Neo 账号（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：Supabase 密码换令牌、relay 换票
   *  两段各要等的上限；到点按「账号服务连不上」给重试，不无限转圈。 */
  accountLoginTimeoutMs: 15_000,
  /** 账号邮箱长度上限（RFC 5321 上限），登录表单与配对信息里带的电脑账号邮箱同用这一档。 */
  accountEmailMaxLength: 254,
  /**
   * relay 找回（N-COMPANION-RELAY-ACCOUNT-RECOVER）：pair-request 挂起时长（relay 侧 pending、
   * Host 侧待同意卡片同用一档）。照邀请 TTL 120s 的量级——电脑前的人要读 4 位码再点同意。
   */
  relayPairTtlMs: 120_000,
  /**
   * 同意后等手机续帧的回收窗（ai-review R4 Important，Host 侧）：relay 的挂起在 relayPairTtlMs
   * （初次请求起算）就到点，续帧再晚也过不去 relay；多留 60s 盖两侧时钟偏差（与票据侧
   * CLOCK_SKEW_S 同量级）。必须严格 > relayPairTtlMs——deadline 前一刻才同意的续帧（R3 Nit4
   * 钉住的行为）在同意后一个完整 TTL 内仍要能落地，回收窗恰好一个 TTL 会在边界误杀它。
   */
  relayPairApprovedTtlMs: 180_000,
  /** pair-request 初次请求的限流间隔（每连接与每账号同判）：防「卡片轰炸电脑」。续帧不计。 */
  relayPairRequestMinIntervalMs: 5_000,
  /** Host 侧找回配对的挂起条数上限（R3 Nit3）：节流不能全押 relay 的限流——Host 自己也兜一层，
   *  满了拒新并留痕（桌面卡片一次只示一张，堆积只可能是异常节奏）。 */
  relayMaxPendingPairs: 8,
  /** register 自报 hostName 的长度上限（列表行显示用，超出按非法帧拒）。 */
  relayHostNameLength: 64,
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
