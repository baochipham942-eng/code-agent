import { COMPANION_LIMITS as L } from '../constants/companion';

/**
 * endpoint 是「此刻一定连得上」的那个地址（私网 IPv4 字面量），altEndpoint 是宿主的 mDNS 名。
 * 两个都给：mDNS 名换网后仍有效（宿主换网不用重扫码），但它不是哪儿都能解析——
 * 2026-09-12 真机实测，Mac 连着 iPhone 热点时手机解析不了宿主的 .local（Safari 直连同样「找不到服务器」），
 * 只广告 mDNS 名会让这个官方推荐场景 100% 配不上。
 * endpoint 是单数是另一个坑：宿主多张私网接口时它只取接口枚举的第一张，可能是手机根本不在的
 * 那一张，热点下 .local 又解析不了 ⇒ 两个候选全灭。candidates 把「数字 IP 候选」补成复数。
 */
export interface LanInvitation {
  version: 1; endpoint: string; altEndpoint?: string; inviteId: string; psk: string; hostKey: string; expiresAt: number;
  /** 6-digit check code derived from psk‖hostKey. Absent on older hosts; older phones ignore it. */
  verify?: string;
  /**
   * 宿主此刻**全部**私网 IPv4 字面量端点，按接口枚举顺序（含 endpoint 那条，手机侧去重保序）。
   * 旧宿主不带；旧手机按未知字段忽略——结构与本文件其余可选字段一样对额外字段不拒绝。
   */
  candidates?: string[];
}
export type CompanionTranscriptionReadiness = 'ready' | 'not-installed' | 'no-key';

export interface LanBinding {
  version: 1; endpoint: string; altEndpoint?: string; hostKey: string; deviceId: string; scopeEpoch: number; scope: string[];
  /** Host advertises the dictation exchange action. Absent on older hosts — phone must not send it. */
  dictation?: true;
  /**
   * 分段转写（voice.transcribe，Groq 密钥）的就绪三态（N-MOBILE-VOICE-TRANSCRIBE-FIX）。
   * 旧宿主不声明：手机按「未知」处理，已有会话仍可开录（旧行为）；欢迎页麦克风另看 sessionlessTranscribe。
   */
  transcription?: CompanionTranscriptionReadiness;
  /**
   * 实时听写（百炼密钥）的就绪三态。只在宿主广告了 dictation 时随之下发——两条转写路各用各的密钥，
   * 手机预检要按它将走的那条判，不能拿 Groq 的三态拦实时听写（N-MOBILE-VOICE-TRANSCRIBE-FIX-R6）。
   * 旧宿主不声明：手机按「未知」处理，维持「实时听写本就能用」的旧行为。
   */
  dictationTranscription?: CompanionTranscriptionReadiness;
  /** Host accepts voice.transcribe without a session. Absent on older hosts — welcome page hides the mic. */
  sessionlessTranscribe?: true;
  /**
   * 电脑当前登录的 Neo 账号邮箱（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：手机登录页预填与
   * 「这台电脑属于谁」的账号一致性核对都从这里取。旧宿主不下发；每次握手随 welcome 刷新，
   * 电脑登录/退出/换账号都会在下一次恢复连接时反映进来。
   */
  hostAccountEmail?: string;
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
 * literal it survives the host changing networks, which is why an invitation carries it as the
 * alternate address (`altEndpoint`) — it is the alternate rather than the primary because reachable
 * is not the same as resolvable: a phone hosting the personal hotspot its host sits on cannot
 * resolve that host's `.local` at all (2026-09-12 真机实测).
 * Reach is not trust: the peer still has to pass the Noise handshake against the pinned hostKey,
 * so a squatted mDNS name gets an attacker a TCP connection and nothing else.
 */
function isMdnsHostname(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.local$/i.test(host);
}
/**
 * What a phone stores has to outlive the address it was paired on: an IPv4 literal dies the moment
 * the host joins another network (or the same one with a new lease), and the only cure is scanning
 * a fresh QR. An mDNS name does not move, so an invitation carries it alongside the literal whenever
 * the host has one — the literal stays the primary address (it is what definitely answers right now,
 * and what phones built before altEndpoint understand), the name is what a paired phone falls back to
 * after the host changes networks. Hosts without Bonjour (Linux/Windows) only ever get the literal.
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
/** SHA-256 of psk‖hostKey, first 32 bits mod 10^6, zero-padded. Same materials ⇒ same code. */
export function deriveInvitationVerify(psk: string, hostKey: string): string {
  const material = new Uint8Array(64);
  material.set(fromHex(psk, 32), 0);
  material.set(fromHex(hostKey, 32), 32);
  const n = new DataView(sha256(material).buffer).getUint32(0);
  return String(n % 1_000_000).padStart(6, '0');
}
/** Design grouping: 472891 → "472 891". */
export function formatInvitationVerify(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
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
  // 每条候选过 endpoint 同一道白名单（错误分类与 altEndpoint 一致：容器形状不对是邀请级错，
  // 单条值不合法是端点级 COMPANION_INVALID_LAN_ENDPOINT）。
  if (v.candidates !== undefined) {
    if (!Array.isArray(v.candidates) || v.candidates.length < 1 || v.candidates.length > L.invitationMaxCandidates ||
        v.candidates.some(candidate => typeof candidate !== 'string')) throw new Error('COMPANION_INVALID_INVITATION');
    for (const candidate of v.candidates) validateLanEndpoint(candidate);
  }
  fromHex(v.psk, 32); fromHex(v.hostKey, 32);
  if (v.verify !== undefined) {
    if (typeof v.verify !== 'string' || !/^\d{6}$/.test(v.verify)) throw new Error('COMPANION_INVALID_INVITATION');
  }
  return v;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256(message: Uint8Array): Uint8Array {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bitLen = message.length << 3;
  const pad = (message.length + 9 + 63) & ~63;
  const bytes = new Uint8Array(pad);
  bytes.set(message);
  bytes[message.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(pad - 4, bitLen);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < pad; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const temp1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const temp2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0); outView.setUint32(4, h1); outView.setUint32(8, h2); outView.setUint32(12, h3);
  outView.setUint32(16, h4); outView.setUint32(20, h5); outView.setUint32(24, h6); outView.setUint32(28, h7);
  return out;
}
