import { z } from 'zod';
import { COMPANION_LIMITS as L } from '../constants/companion';

/** Wire version. Unknown values are rejected; later versions occupy this field. */
const COMPANION_RELAY_PROTOCOL_VERSION = 1 as const;

const routeToken = z.string().trim().min(16).max(L.idLength).regex(/^[A-Za-z0-9_-]+$/);
const deviceRef = z.string().trim().min(1).max(L.idLength);
const seq = z.number().int().nonnegative().safe();
const ttlMs = z.number().int().positive().max(L.relayRouteTokenTtlMs).safe();
const issuedAt = z.number().int().positive().safe();

const companionRelayEnvelopeSchema = z.object({
  routeToken,
  deviceRef,
  seq,
  ttlMs,
  issuedAt,
  idempotencyKey: z.string().trim().min(1).max(L.idLength).optional(),
}).strict();

const controlCiphertext = z.literal('');
const opaqueCiphertext = z.string().min(1).max(L.maxFrameBytes * L.maxRequestRecords);

const frameBase = {
  v: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
  envelope: companionRelayEnvelopeSchema,
};

const companionRelayFrameSchema = z.discriminatedUnion('kind', [
  z.object({ ...frameBase, kind: z.literal('register'), role: z.enum(['host', 'device']), ciphertext: controlCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('unregister'), ciphertext: controlCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('heartbeat'), ciphertext: controlCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('ack'), ciphertext: controlCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('revoke'), ciphertext: controlCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('disconnect'), ciphertext: controlCiphertext }).strict(),
  /**
   * relay → device only（N-COMPANION-RELAY-NOHOST-FASTFAIL）：设备注册后宽限期内这条 route 上一直
   * 没有 host。新手机据此秒级失败；旧手机不认识这个 kind，按非法帧断开——同样秒级失败，只是文案泛化。
   */
  z.object({ ...frameBase, kind: z.literal('no-host'), ciphertext: controlCiphertext }).strict(),
  /**
   * relay → host only（N-COMPANION-RELAY-DEVICE-TICKET）：账号通道鉴权成功后 relay 直接在本连接上
   * 下发的设备票据，放在 ciphertext——对 relay 之外的所有人是不透明串（无法伪造、无法离线验签）。
   * 信封用固定 sentinel（routeToken 'neo-relay-ticket-issue' / deviceRef 'relay' / seq 0），与
   * no-host 同一套写法：票据不走路由，不会与任何真实 route 的转发混淆。旧 Host 不认识该 kind，
   * 解析失败静默丢帧，行为不受影响。
   */
  z.object({ ...frameBase, kind: z.literal('ticket'), ciphertext: opaqueCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('handshake'), ciphertext: opaqueCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('forward'), ciphertext: opaqueCiphertext }).strict(),
]);
export type CompanionRelayFrame = z.infer<typeof companionRelayFrameSchema>;

export const companionRelayConfigSchema = z.object({
  v: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
  enabled: z.boolean(),
  url: z.string().trim().min(1).max(2_048).optional(),
  credentialRef: z.string().trim().min(1).max(L.idLength).optional(),
  reconnectBackoffMs: z.array(z.number().int().positive().max(L.relayIdleMs).safe()).min(1).max(8).optional(),
  /** Extra CA file for this Host dial only; PEM is read by the Host loader, not sent to the relay. */
  caFile: z.string().trim().min(1).max(L.relayCaFileLength).optional(),
}).strict();
export interface CompanionRelayResolved {
  url: string;
  credentialRef: string;
  reconnectBackoffMs: readonly number[];
  /** Extra CA PEM appended to Node's trust store for this dial only. */
  caPem?: string;
}

export function parseCompanionRelayFrame(raw: unknown): CompanionRelayFrame {
  const parsed = companionRelayFrameSchema.safeParse(raw);
  if (!parsed.success) throw new Error('COMPANION_RELAY_INVALID_FRAME');
  return parsed.data;
}

export function companionRelayFrameExpired(frame: CompanionRelayFrame, now: number): boolean {
  return frame.envelope.issuedAt + frame.envelope.ttlMs <= now;
}

/**
 * relay 服务端帧的固定信封 sentinel（ticket / no-host 同一套写法）：这类帧不走路由，任何真实
 * route 的转发都不会长这个样子。ticket 帧由 relay 签发、Host 消费（旧 Host 与手机不认识该
 * kind，静默丢帧）——relay 服务端与 Host 客户端两侧都以这里为准，别在别处再抄字面量。
 */
export const COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN = 'neo-relay-ticket-issue';
/** 服务端帧（ticket / no-host）的 deviceRef sentinel：帧来自 relay 本体，不是某台设备的转发。 */
export const COMPANION_RELAY_SENTINEL_DEVICE_REF = 'relay';

/**
 * Loopback `ws:` is for the in-process fake relay. Any other host must use `wss:`.
 * Credentials never belong in the URL.
 */
function parseCompanionRelayUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('COMPANION_RELAY_INVALID_URL'); }
  if (url.username || url.password || url.hash || url.search) throw new Error('COMPANION_RELAY_INVALID_URL');
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (url.protocol === 'ws:') {
    if (!loopback) throw new Error('COMPANION_RELAY_INSECURE_URL');
  } else if (url.protocol !== 'wss:') {
    throw new Error('COMPANION_RELAY_INVALID_URL');
  }
  return url.toString();
}

export function resolveCompanionRelayConfig(raw: unknown): CompanionRelayResolved | null {
  const parsed = companionRelayConfigSchema.safeParse(raw);
  if (!parsed.success || parsed.data.enabled !== true || !parsed.data.url || !parsed.data.credentialRef) return null;
  return {
    url: parseCompanionRelayUrl(parsed.data.url),
    credentialRef: parsed.data.credentialRef,
    reconnectBackoffMs: parsed.data.reconnectBackoffMs ?? L.relayReconnectBackoffMs,
  };
}

/**
 * 一台已配对手机的 relay 路由：Host 经 Noise 加密信道下发给手机缓存，LAN 不可达时按它拨 relay。
 * routeToken 由 Host 持久身份密钥确定性派生（重启不变，见 companionRelayRouteToken.ts），在
 * relay 侧的存活期是短 TTL；credential 与 Host 拨 relay 用的是同一个共享路由凭据（不是长期
 * 内容密钥）。手机缓存它进配对盘（设备上是 Keychain）。
 */
const companionRelayRouteSchema = z.object({
  v: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
  url: z.string().trim().min(1).max(2_048),
  routeToken,
  credential: z.string().trim().min(L.relayAuthLength).max(256),
}).strict();
export type CompanionRelayRoute = z.infer<typeof companionRelayRouteSchema>;

export function parseCompanionRelayRoute(raw: unknown): CompanionRelayRoute {
  const parsed = companionRelayRouteSchema.safeParse(raw);
  if (!parsed.success) throw new Error('COMPANION_RELAY_INVALID_ROUTE');
  return { ...parsed.data, url: parseCompanionRelayUrl(parsed.data.url) };
}

/**
 * 凭据子协议（N-COMPANION-RELAY-PHONE-AUTH）：WebView 的 WebSocket 设不了请求头，手机
 * 侧把共享凭据放进 `Sec-WebSocket-Protocol`。客户端固定发两项：协议名 + 凭据项；服务端
 * `handleProtocols` 只回选协议名，凭据项解出来后与 `Authorization` 头同一口径比较，绝不
 * 回选或回显。生产凭据含 `=` 等不合法的 token 字符，必须编码后才能进协议头。
 */
export const COMPANION_RELAY_WS_PROTOCOL = 'neo-relay.v1';
const COMPANION_RELAY_WS_AUTH_PREFIX = 'neo-relay-auth.';

/** 凭据 → `neo-relay-auth.<base64url>`：trim 后取 UTF-8 字节，无 padding 的 base64url。 */
export function companionRelayCredentialSubprotocol(credential: string): string {
  const bytes = new TextEncoder().encode(credential.trim());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return COMPANION_RELAY_WS_AUTH_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
