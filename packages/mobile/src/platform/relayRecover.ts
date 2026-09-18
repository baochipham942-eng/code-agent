import type { KeyPair } from 'noise-handshake';
import { createRelayPairHandshake, deriveRelayPairVerify } from '../../../../src/shared/companion/relayPair';
import { NoiseChannel } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, sha256, toHex, type CompanionTranscriptionReadiness } from '../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN,
  COMPANION_RELAY_PAIR_ROUTE_TOKEN,
  COMPANION_RELAY_SENTINEL_DEVICE_REF,
  COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN,
  parseCompanionRelayFrame,
  parseCompanionRelayHostList,
  parseCompanionRelayRoutes,
  type CompanionRelayHostEntry,
  type CompanionRelayRoute,
  type CompanionRelayRouteRef,
  type CompanionRelayFrame,
} from '../../../../src/shared/contract/companionRelay';
import { passwordGrant } from './accountLogin';
import type { RelayDial, RelayDialSocket } from './relayCompanionClient';

/**
 * 手机「登录找回我的电脑」（N-COMPANION-RELAY-ACCOUNT-RECOVER）的协议客户端：邮箱密码换
 * access token（只进内存）→ 以账号身份连 relay（list-hosts 列在线电脑）→ 对选中电脑跑纯 XX
 * 配对交换（pair-request → 同意后的 pair-result(reply) → 续帧 → pair-result(complete)）。
 *
 * 安全纪律与 accountLogin 同源：access token 与密码不落盘、不进日志——落盘的只有 relay 在本
 * 连接上下发的设备票据（随配对结果交给 store 进配对盘）。relay 在 JWT 鉴权成功时自动发 ticket
 * 帧（刀 3A），这里收好它。D11：找到电脑即完事，手机不保留任何 Supabase 会话。
 */

export type RecoverOpenError = { kind: 'invalidCredentials' } | { kind: 'unreachable' } | { kind: 'noHosts' };
export type RecoverPairError =
  | { kind: 'declined' }
  | { kind: 'timeout' }
  | { kind: 'hostOffline' }
  | { kind: 'rateLimited' }
  | { kind: 'hostUpgrade' }
  | { kind: 'hostMismatch' }
  | { kind: 'unreachable' };

/** pair-result(complete) 解封后的配对载荷：welcome 等值内容 + relay.routes 双路由 + LAN 地址。 */
export interface RelayRecoverPayload {
  deviceId: string;
  scopeEpoch: number;
  scope: string[];
  transcription?: CompanionTranscriptionReadiness;
  sessionlessTranscribe?: true;
  dictation?: true;
  dictationTranscription?: CompanionTranscriptionReadiness;
  hostAccountEmail?: string;
  lan?: { endpoint: string; altEndpoint?: string | null; candidates?: string[] };
  legacyRoute?: CompanionRelayRoute;
  accountRoute?: CompanionRelayRouteRef;
}

export type RelayRecoverPairOutcome =
  | { ok: true; payload: RelayRecoverPayload; hostKey: string }
  | { ok: false } & RecoverPairError;

/** 找回会话：S4 登录成功后持有，直到选电脑配对完成 / 取消 / 连接断。 */
export interface RelayRecoverSession {
  readonly email: string;
  readonly userId: string;
  /** relay 在本连接上下发的设备票据；配对完成随结果落进配对盘（account 一格）。 */
  readonly ticket: string | null;
  readonly hosts: readonly CompanionRelayHostEntry[];
  /**
   * S6：向目标电脑发起配对。code 立即返回（4 位核对码，S6 要先显示），result 等电脑表态——
   * 同意走完 XX 三消息并带回配对载荷；拒绝/超时/断开给具名失败。
   */
  pair(target: CompanionRelayHostEntry, identity: KeyPair): { code: string; result: Promise<RelayRecoverPairOutcome> };
  close(): void;
}

/** 找回等待的统一上限：列电脑秒级，配对等电脑前的人表态（与邀请 TTL 同量级，盖两腿往返）。 */
const LIST_WAIT_MS = L.accountLoginTimeoutMs;
const PAIR_WAIT_MS = L.relayPairTtlMs + L.accountLoginTimeoutMs;

function sentinelEnvelope(routeToken: string) {
  return {
    routeToken, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF,
    seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now(),
  };
}

/** 配对载荷的路由/字段逐条校验：坏载荷不猜内容，按 unreachable 结算（fail-closed）。 */
function readRecoverPayload(value: unknown): RelayRecoverPayload | null {
  const raw = value as Partial<RelayRecoverPayload> & { routes?: unknown };
  if (!raw || typeof raw.deviceId !== 'string' || !raw.deviceId || raw.deviceId.length > L.idLength
    || !Number.isSafeInteger(raw.scopeEpoch) || Number(raw.scopeEpoch) < 1
    || !Array.isArray(raw.scope) || raw.scope.length < 1 || raw.scope.length > L.maxScopeSessions
    || raw.scope.some(id => typeof id !== 'string' || !id || id.length > L.idLength)) return null;
  let legacyRoute: CompanionRelayRoute | undefined;
  let accountRoute: CompanionRelayRouteRef | undefined;
  try {
    // routes 的形状与 `relay.routes` 动作载荷完全同源：直接走同一个 parse（含 URL 纪律）。
    const routes = parseCompanionRelayRoutes(raw.routes);
    if (routes.legacy) legacyRoute = routes.legacy;
    if (routes.account) accountRoute = routes.account;
  } catch { return null; }
  const lan = raw.lan;
  if (lan !== undefined && (typeof lan?.endpoint !== 'string' || !lan.endpoint)) return null;
  const transcription = raw.transcription;
  const dictationTranscription = raw.dictationTranscription;
  return {
    deviceId: raw.deviceId, scopeEpoch: Number(raw.scopeEpoch), scope: raw.scope as string[],
    ...(transcription === 'ready' || transcription === 'not-installed' || transcription === 'no-key' ? { transcription } : {}),
    ...(raw.sessionlessTranscribe === true ? { sessionlessTranscribe: true as const } : {}),
    ...(raw.dictation === true ? { dictation: true as const, ...(dictationTranscription === 'ready' || dictationTranscription === 'not-installed' || dictationTranscription === 'no-key' ? { dictationTranscription } : {}) } : {}),
    ...(typeof raw.hostAccountEmail === 'string' && raw.hostAccountEmail.trim() && raw.hostAccountEmail.length <= L.accountEmailMaxLength ? { hostAccountEmail: raw.hostAccountEmail } : {}),
    ...(lan ? { lan } : {}),
    ...(legacyRoute ? { legacyRoute } : {}),
    ...(accountRoute ? { accountRoute } : {}),
  };
}

/**
 * 打开找回会话：密码换 token → 连 relay（Bearer token 进凭据子协议，与换票同一条路）→
 * list-hosts。空列表按 noHosts 结算（relay 路由表是内存短 TTL，只列在线电脑——S5 不做离线行）。
 * 旧 relay 把 list-hosts 当非法帧关连接 ⇒ unreachable（S7 文案），部署顺序 relay → Host → 手机。
 */
export async function openRelayRecoverSession(input: {
  email: string;
  password: string;
  relayUrl: string;
  dial: RelayDial;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; session: RelayRecoverSession } | { ok: false } & RecoverOpenError> {
  const grant = await passwordGrant(input.email, input.password, input.fetchImpl ?? fetch);
  if ('error' in grant) return { ok: false, kind: grant.error };
  return new Promise(resolve => {
    let settled = false;
    let socket: RelayDialSocket | null = null;
    let ticket: string | null = null;
    /** 单飞等待槽：找回流严格串行（list → pair → 续帧），一个槽位就够；迟到的帧丢弃。 */
    let waiter: { resolve(frame: CompanionRelayFrame): void; reject(error: Error): void } | null = null;
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const clearListTimer = () => { if (listTimer !== null) { clearTimeout(listTimer); listTimer = null; } };
    const finishOpen = (outcome: { ok: true; session: RelayRecoverSession } | { ok: false } & RecoverOpenError) => {
      if (settled) return;
      settled = true;
      clearListTimer();
      if (!outcome.ok) {
        waiter = null;
        try { socket?.close(); } catch { /* 已死 */ }
        socket = null;
      }
      resolve(outcome);
    };
    const onSocketClosed = () => {
      clearListTimer();
      if (!settled) { finishOpen({ ok: false, kind: 'unreachable' }); return; }
      // 会话开着时断线：把在飞的配对等待者拒掉（pair 侧按 unreachable 结算）。
      waiter?.reject(new Error('COMPANION_RELAY_CLOSED'));
      waiter = null;
    };
    const makeSession = (hosts: CompanionRelayHostEntry[]): RelayRecoverSession => ({
      email: grant.email,
      userId: grant.userId,
      ticket,
      hosts,
      pair: (target, identity) => {
        const noise = createRelayPairHandshake(true, identity);
        const first = noise.send();
        const code = deriveRelayPairVerify(noise.e!.publicKey);
        const requestId = crypto.randomUUID();
        const result = new Promise<RelayRecoverPairOutcome>(resolvePair => {
          const settle = (outcome: RelayRecoverPairOutcome) => {
            clearTimeout(timer);
            waiter = null;
            resolvePair(outcome);
          };
          const timer = setTimeout(() => settle({ ok: false, kind: 'timeout' }), PAIR_WAIT_MS);
          const waitReply = () => new Promise<CompanionRelayFrame>((resolveWait, rejectWait) => {
            waiter = { resolve: resolveWait, reject: rejectWait };
          });
          void (async () => {
            try {
              socket!.send(JSON.stringify({
                v: 1, kind: 'pair-request', requestId, instanceId: target.instanceId,
                envelope: sentinelEnvelope(COMPANION_RELAY_PAIR_ROUTE_TOKEN), ciphertext: toHex(first),
              } satisfies CompanionRelayFrame));
              const reply = await waitReply();
              if (reply.kind !== 'pair-result' || reply.requestId !== requestId) throw new Error('COMPANION_NO_RESPONSE');
              if (!reply.accepted) {
                settle({ ok: false, kind: reply.reason === 'declined' ? 'declined'
                  : reply.reason === 'rate-limited' ? 'rateLimited'
                  : reply.reason === 'timeout' ? 'timeout' : 'hostOffline' });
                return;
              }
              if (reply.stage !== 'reply') throw new Error('COMPANION_NO_RESPONSE');
              // 电脑身份钉死在 list-hosts 给的指纹上：XX 第二条消息带回主机静态公钥，逐字节核对。
              if (noise.recv(fromHex(reply.ciphertext)).length !== 0 || !noise.rs) throw new Error('COMPANION_INVALID_FRAME');
              if (toHex(sha256(noise.rs)) !== target.fingerprint) { settle({ ok: false, kind: 'hostMismatch' }); return; }
              socket!.send(JSON.stringify({
                v: 1, kind: 'pair-request', requestId,
                envelope: sentinelEnvelope(COMPANION_RELAY_PAIR_ROUTE_TOKEN), ciphertext: toHex(noise.send()),
              } satisfies CompanionRelayFrame));
              const complete = await waitReply();
              if (complete.kind !== 'pair-result' || complete.requestId !== requestId || !complete.accepted || complete.stage !== 'complete') {
                throw new Error('COMPANION_NO_RESPONSE');
              }
              const channel = new NoiseChannel(noise);
              const payload = readRecoverPayload(channel.open(JSON.parse(complete.ciphertext) as unknown));
              if (!payload) throw new Error('COMPANION_INVALID_FRAME');
              settle({ ok: true, payload, hostKey: toHex(noise.rs) });
            } catch (error) {
              const message = error instanceof Error ? error.message : '';
              // 连接已断（close 把等待者拒掉）：没有电脑可等了。
              if (message === 'COMPANION_RELAY_CLOSED') { settle({ ok: false, kind: 'unreachable' }); return; }
              settle({ ok: false, kind: message === 'COMPANION_NO_RESPONSE' ? 'timeout' : 'unreachable' });
            }
          })();
        });
        return { code, result };
      },
      close: () => {
        waiter?.reject(new Error('COMPANION_RELAY_CLOSED'));
        waiter = null;
        try { socket?.close(); } catch { /* 已死 */ }
        socket = null;
      },
    });
    const onFrame = (frame: CompanionRelayFrame) => {
      // ticket 帧先于一切等待处理（sentinel 校验同 Host 侧）：它在任何一步都可能插进来。
      if (frame.kind === 'ticket'
        && frame.envelope.routeToken === COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN
        && frame.envelope.deviceRef === COMPANION_RELAY_SENTINEL_DEVICE_REF) {
        ticket = frame.ciphertext;
        return;
      }
      if (frame.kind === 'list-hosts' && frame.envelope.routeToken === COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN) {
        if (settled) return;
        try {
          const hosts = parseCompanionRelayHostList(JSON.parse(frame.ciphertext) as unknown);
          if (!hosts.length) { finishOpen({ ok: false, kind: 'noHosts' }); return; }
          finishOpen({ ok: true, session: makeSession(hosts) });
        } catch { finishOpen({ ok: false, kind: 'unreachable' }); }
        return;
      }
      if (frame.kind === 'pair-result' && frame.envelope.routeToken === COMPANION_RELAY_PAIR_ROUTE_TOKEN) {
        waiter?.resolve(frame);
        return;
      }
    };
    try {
      socket = input.dial(input.relayUrl, { authorization: `Bearer ${grant.accessToken}` });
    } catch {
      finishOpen({ ok: false, kind: 'unreachable' });
      return;
    }
    listTimer = setTimeout(() => { if (!settled) finishOpen({ ok: false, kind: 'unreachable' }); }, LIST_WAIT_MS);
    socket.onError(() => { /* close 随后结算 */ });
    socket.onClose(onSocketClosed);
    socket.onOpen(() => {
      try {
        socket!.send(JSON.stringify({
          v: 1, kind: 'list-hosts',
          envelope: sentinelEnvelope(COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN), ciphertext: '',
        } satisfies CompanionRelayFrame));
      } catch { finishOpen({ ok: false, kind: 'unreachable' }); }
    });
    socket.onMessage(raw => {
      if (!socket) return;
      try { onFrame(parseCompanionRelayFrame(JSON.parse(raw) as unknown)); }
      catch { if (!settled) finishOpen({ ok: false, kind: 'unreachable' }); }
    });
  });
}
