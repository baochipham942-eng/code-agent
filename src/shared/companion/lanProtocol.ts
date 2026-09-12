import { COMPANION_LIMITS as L } from '../constants/companion';

/**
 * endpoint 是「此刻一定连得上」的那个地址（私网 IPv4 字面量），altEndpoint 是宿主的 mDNS 名。
 * 两个都给：mDNS 名换网后仍有效（宿主换网不用重扫码），但它不是哪儿都能解析——
 * 2026-09-12 真机实测，Mac 连着 iPhone 热点时手机解析不了宿主的 .local（Safari 直连同样「找不到服务器」），
 * 只广告 mDNS 名会让这个官方推荐场景 100% 配不上。
 */
export interface LanInvitation {
  version: 1; endpoint: string; altEndpoint?: string; inviteId: string; psk: string; hostKey: string; expiresAt: number;
}
export interface LanBinding {
  version: 1; endpoint: string; altEndpoint?: string; hostKey: string; deviceId: string; scopeEpoch: number; scope: string[];
}
export const LAN_PROLOGUE = 'neo-companion/lan/v1';
export function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function fromHex(value: unknown, bytes?: number): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || value.length > L.maxFrameBytes * 2 ||
      (bytes !== undefined && value.length !== bytes * 2)) throw new Error('COMPANION_INVALID_FRAME');
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}
export function isPrivateIPv4(host: string): boolean {
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some(n => !/^(0|[1-9]\d{0,2})$/.test(n) || Number(n) > 255)) return false;
  const [a, b] = octets.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
/**
 * Callers on this very machine, which an mDNS name resolves to over loopback whenever the host
 * talks to itself. Kept apart from isPrivateIPv4() on purpose: a loopback peer is allowed to
 * reach the server (it is the host's own process), while a loopback *endpoint* stays rejected
 * below — a phone can never dial the host's 127.0.0.1.
 */
function isLoopbackHost(host: string): boolean {
  return host === '::1' || /^127\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(host);
}
/**
 * Who may reach the LAN surface at all. Enforced at the TCP layer (connection accepted then
 * destroyed) rather than only per-request, so a caller outside the link cannot hold sockets open
 * against maxConnections while the HTTP layer would have 403'd it anyway.
 */
export function isLanPeer(peer: string): boolean {
  return isPrivateIPv4(peer) || isLoopbackHost(peer);
}
/**
 * RFC 6762 reserves `.local` for mDNS: public DNS never answers it, so such a name can only
 * resolve to a host on the same link — the same reach a private IPv4 literal has. Unlike the
 * literal it survives the host changing networks, which is why an invitation prefers it.
 * Reach is not trust: the peer still has to pass the Noise handshake against the pinned hostKey,
 * so a squatted mDNS name gets an attacker a TCP connection and nothing else.
 */
function isMdnsHostname(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.local$/i.test(host);
}
/**
 * What a phone stores has to outlive the address it was paired on: an IPv4 literal dies the moment
 * the host joins another network (or the same one with a new lease), and the only cure is scanning
 * a fresh QR. An mDNS name does not move, so an invitation advertises it whenever the host has one
 * and keeps the literal for hosts that do not (Linux/Windows without Bonjour).
 */
export function lanAdvertisedHost(address: string, mdnsName: string | null): string {
  return mdnsName && isMdnsHostname(mdnsName) ? mdnsName.toLowerCase() : address;
}
export function validateLanEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !(isPrivateIPv4(url.hostname) || isMdnsHostname(url.hostname)) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== endpoint) {
    throw new Error('COMPANION_INVALID_LAN_ENDPOINT');
  }
  return endpoint;
}
export function parseInvitation(raw: string, now = Date.now()): LanInvitation {
  if (raw.length > 2_048) throw new Error('COMPANION_INVALID_INVITATION');
  const v = JSON.parse(raw) as LanInvitation;
  if (v.version !== 1 || typeof v.endpoint !== 'string' || typeof v.inviteId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(v.inviteId) || !Number.isSafeInteger(v.expiresAt) ||
      v.expiresAt <= now || v.expiresAt > now + L.invitationTtlMs) throw new Error('COMPANION_INVALID_INVITATION');
  validateLanEndpoint(v.endpoint);
  if (v.altEndpoint !== undefined) {
    if (typeof v.altEndpoint !== 'string') throw new Error('COMPANION_INVALID_INVITATION');
    validateLanEndpoint(v.altEndpoint);
  }
  fromHex(v.psk, 32); fromHex(v.hostKey, 32);
  return v;
}
