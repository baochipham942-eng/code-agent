import { z } from 'zod';
import { COMPANION_LIMITS as L } from '../constants/companion';

/** Wire version. Unknown values are rejected; later versions occupy this field. */
const COMPANION_RELAY_PROTOCOL_VERSION = 1 as const;

const routeToken = z.string().trim().min(16).max(L.idLength).regex(/^[A-Za-z0-9_-]+$/);
const deviceRef = z.string().trim().min(1).max(L.idLength);
/**
 * 注册连接的实例身份（N-COMPANION-RELAY-ROUTE-TAKEOVER）：Host 每个进程生命周期随机生成的
 * 内存 nonce（base64url），与 routeToken 同字符集。判「同 token 换了实例（顶替）」与「同实例
 * 重连」全靠它——optional 是为了接住旧 Host / 手机（device 角色不发它）。
 */
const instanceId = z.string().trim().min(16).max(L.idLength).regex(/^[A-Za-z0-9_-]+$/).optional();
/**
 * 一次 relay 找回配对交换的代号（N-COMPANION-RELAY-ACCOUNT-RECOVER）：手机生成，pair-request
 * 与 pair-result 都带同一个；relay 靠它把电脑的应答送回发起的那条手机连接。
 */
const pairRequestId = z.string().trim().min(16).max(L.idLength).regex(/^[A-Za-z0-9_-]+$/);
/** Host 自报的主机公钥指纹：sha256(32 字节公钥) 的 hex（64 字符）。旧 Host 不带。 */
const hostKeyFingerprint = z.string().regex(/^[0-9a-f]{64}$/);
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
  /**
   * register 自报字段（N-COMPANION-RELAY-ACCOUNT-RECOVER）：hostName 是电脑名（list-hosts 列表行
   * 显示用），hostKeyFingerprint 是 Host 身份公钥指纹——手机选电脑时只见指纹，配对握手后与
   * Noise 学到的对端静态公钥核对（pinned）。两者 optional：旧 Host 不带，列表相应降级（无名/
   * 无指纹 ⇒ 手机按「电脑上的 Neo 需要升级后才能找回」降级，不发 pair-request）。
   */
  z.object({
    ...frameBase, kind: z.literal('register'), role: z.enum(['host', 'device']), instanceId,
    hostName: z.string().trim().min(1).max(L.relayHostNameLength).optional(),
    hostKeyFingerprint: hostKeyFingerprint.optional(),
    ciphertext: controlCiphertext,
  }).strict(),
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
  /**
   * relay 找回（N-COMPANION-RELAY-ACCOUNT-RECOVER）：手机→relay 请求与 relay→手机 回帧同一个
   * kind——请求 ciphertext 为空串，回帧 ciphertext 是 JSON 数组（parseCompanionRelayHostList）。
   * 不走路由：信封 routeToken 用 COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN sentinel，只认
   * acct 主人（JWT/票据鉴权的连接；legacy 连接发起被拒并记 stats）。
   */
  z.object({ ...frameBase, kind: z.literal('list-hosts'), ciphertext: z.string().max(L.maxFrameBytes) }).strict(),
  /**
   * 手机→relay→Host 的配对请求（XX 第一条消息 hex）。带 instanceId = 初次请求（目标 Host 实例）；
   * 不带 = 同一交换的续帧（requestId 对上 relay 挂起态，内容是 XX 第三条消息——电脑同意后
   * 手机补完握手的那一腿，relay 照原样转发、不计限流）。
   */
  z.object({ ...frameBase, kind: z.literal('pair-request'), requestId: pairRequestId, instanceId, ciphertext: opaqueCiphertext }).strict(),
  /**
   * Host→relay→手机（relay 也在目标不在/限流/挂起超时时自行合成）：accepted=false 时 reason 具名
   * （declined 电脑拒绝 / timeout 挂起超时 / host-offline 目标不在线或腿断 / rate-limited 限流），
   * ciphertext 为空串；accepted=true 时 stage 区分——'reply' = 同意后的 XX 第二条消息（hex），
   * 'complete' = 第三条消息落地后用会话密钥封的配对载荷（JSON 密文记录，内含 welcome 等值内容
   * 与 relay.routes 双路由）。
   */
  z.object({
    ...frameBase, kind: z.literal('pair-result'),
    requestId: pairRequestId,
    accepted: z.boolean(),
    reason: z.enum(['declined', 'timeout', 'host-offline', 'rate-limited']).optional(),
    stage: z.enum(['reply', 'complete']).optional(),
    ciphertext: z.string().max(L.maxFrameBytes),
  }).strict(),
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
/** relay 找回（list-hosts 请求/回帧）的固定信封 sentinel：与 ticket 同一套写法，不走路由。 */
export const COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN = 'neo-relay-list-hosts';
/** relay 找回配对交换（pair-request / pair-result）的固定信封 sentinel：同一次交换两向共用。 */
export const COMPANION_RELAY_PAIR_ROUTE_TOKEN = 'neo-relay-pair';

/**
 * list-hosts 回帧 ciphertext 的 JSON 形状（N-COMPANION-RELAY-ACCOUNT-RECOVER）：电脑在 register
 * 里自报的名称与主机公钥指纹 + 实例身份。同一台电脑为每台已配对手机登记一条路由，relay 已按
 * hostInstanceId 去重；名称/指纹缺失（旧 Host）为空串，手机侧据此降级「需要升级」。
 */
export interface CompanionRelayHostEntry { name: string; fingerprint: string; instanceId: string }

const companionRelayHostEntrySchema = z.object({
  name: z.string().max(L.relayHostNameLength),
  fingerprint: z.union([z.literal(''), hostKeyFingerprint]),
  /** 列表行里的 instanceId 必填（只列有实例身份的 host 槽）；字符集与 register 的同源。 */
  instanceId: z.string().trim().min(16).max(L.idLength).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

/** 缺字段/多字段的列表整体按非法处理（手机侧 fail-closed，不猜列表内容）。 */
export function parseCompanionRelayHostList(raw: unknown): CompanionRelayHostEntry[] {
  const parsed = z.array(companionRelayHostEntrySchema).max(L.relayMaxRoutesPerAccount).safeParse(raw);
  if (!parsed.success) throw new Error('COMPANION_RELAY_INVALID_HOST_LIST');
  return parsed.data;
}

/**
 * relay 拒绝「同 token 不同实例顶替 host 槽」后关顶替者连接用的自定 close code
 * （N-COMPANION-RELAY-ROUTE-TAKEOVER；4000 段是 WS 应用自定义区间）。Host 侧据此单具名码
 * `COMPANION_RELAY_ROUTE_TAKEN` 报警，不折叠进 `close <code>` 泛化码。两侧（relay 关、Host 认）
 * 都以这里为单一真源。
 *
 * ⚠️ 部署顺序硬约束：register 帧新增的 optional instanceId 会先于旧 relay 上线——旧 relay 的
 * strict schema 把带新字段的 register 当非法帧直接关连接。**relay 必须先于 Host 升级**，
 * 否则新 Host 一条路由都注册不上。
 *
 * ⚠️ 同一约束对 N-COMPANION-RELAY-ACCOUNT-RECOVER 的新面照样成立，且顺序唯一：**relay → Host →
 * 手机**。新 Host 的 register 带 hostName/hostKeyFingerprint，旧 relay 判非法帧直接关连接（Host
 * 侧退避重连风暴）；新手机的 list-hosts/pair-request/pair-result 到旧 relay 同样整帧非法被关。
 * 新 relay 的 schema 是旧的超集，三个旧端先连上来行为一字不变。新手机对旧 Host 的降级不走这条
 * 硬关断：旧 Host 的 register 不带指纹 ⇒ 列表行 fingerprint 为空 ⇒ 手机按「电脑上的 Neo 需要
 * 升级后才能找回」降级、不发 pair-request（不会重试风暴）。
 */
export const COMPANION_RELAY_CLOSE_CODE_ROUTE_TAKEN = 4001;

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
 * 账号路由引用（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：只有 url + routeToken，不带凭据——
 * 旧路由的共享凭据随配对整份下发，账号路由的凭据（设备票据）由手机自己登录账号换取、
 * 随配对记录里的 `account` 另存，两条凭据形态不同路。Host 登录了 Neo 账号才有这一条。
 */
const companionRelayRouteRefSchema = z.object({
  v: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
  url: z.string().trim().min(1).max(2_048),
  routeToken,
}).strict();
export type CompanionRelayRouteRef = z.infer<typeof companionRelayRouteRefSchema>;

/**
 * 双路由下发契约（`relay.routes` 动作的 routes 载荷）：`legacy` 是既有路由契约原样（含共享
 * 凭据，build 53 老手机缓存的就是它），`account` 是不带凭据的账号路由引用。两者都可选——
 * Host 没配中继或没登录账号时对应条目缺席，手机据此知道哪条路可用。
 * schema 本体不导出（与既有 companionRelayRouteSchema 同一纪律）：外部消费方只认 parse 函数。
 */
const companionRelayRoutesSchema = z.object({
  v: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
  account: companionRelayRouteRefSchema.optional(),
  legacy: companionRelayRouteSchema.optional(),
}).strict();
export type CompanionRelayRoutes = z.infer<typeof companionRelayRoutesSchema>;

/** 缺字段的旧记录/坏载荷不得作废整份：解析失败抛 COMPANION_RELAY_INVALID_ROUTES，调用方按条丢弃。 */
export function parseCompanionRelayRoutes(raw: unknown): CompanionRelayRoutes {
  const parsed = companionRelayRoutesSchema.safeParse(raw);
  if (!parsed.success) throw new Error('COMPANION_RELAY_INVALID_ROUTES');
  const data = parsed.data;
  return {
    v: COMPANION_RELAY_PROTOCOL_VERSION,
    ...(data.account ? { account: { ...data.account, url: parseCompanionRelayUrl(data.account.url) } } : {}),
    ...(data.legacy ? { legacy: { ...data.legacy, url: parseCompanionRelayUrl(data.legacy.url) } } : {}),
  };
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
