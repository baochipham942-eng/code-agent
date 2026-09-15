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
  z.object({ ...frameBase, kind: z.literal('handshake'), ciphertext: opaqueCiphertext }).strict(),
  z.object({ ...frameBase, kind: z.literal('forward'), ciphertext: opaqueCiphertext }).strict(),
]);
export type CompanionRelayFrame = z.infer<typeof companionRelayFrameSchema>;

const companionRelayConfigSchema = z.object({
  v: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
  enabled: z.boolean(),
  url: z.string().trim().min(1).max(2_048).optional(),
  credentialRef: z.string().trim().min(1).max(L.idLength).optional(),
  reconnectBackoffMs: z.array(z.number().int().positive().max(L.relayIdleMs).safe()).min(1).max(8).optional(),
}).strict();
export interface CompanionRelayResolved {
  url: string;
  credentialRef: string;
  reconnectBackoffMs: readonly number[];
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
 * routeToken 是 Host 进程内铸造的短 TTL 路由凭据；credential 与 Host 拨 relay 用的是同一个
 * 共享路由凭据（不是长期内容密钥）。手机缓存它进配对盘（设备上是 Keychain）。
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
