import type { KeyPair } from 'noise-handshake';
import type WebSocket from 'ws';
import type { CompanionRelayStatus } from '../../../shared/contract/companionManagement';
import type { CompanionRelayRoute, CompanionRelayRouteRef } from '../../../shared/contract/companionRelay';
import { CompanionRelayClient, type CompanionRelayPairRequest, type CompanionRelayTicketStore } from './CompanionRelayClient';
import {
  errorHead,
  loadCompanionRelayConfig,
  logCompanionRelayInfo,
  type CompanionRelayLogger,
} from './companionRelayConfig';
import {
  clearCompanionRelayTicket,
  loadCompanionRelayTicket,
  storeCompanionRelayTicket,
} from './companionRelayTicketStore';
import type { CompanionGateway } from './CompanionGateway';

/** 账号通道只需要这三样；authService 单例满足它，测试可直接喂假对象。 */
interface CompanionRelayAccountSource {
  getCurrentUser(): { id: string } | null;
  getAccessToken(): Promise<string | null>;
  addAuthChangeCallback(callback: (user: { id: string } | null) => void): () => void;
}

/** 账号通道对设置页自报的状态（CompanionRelayStatus 的 account 部分，由装配层拼上 legacy）。 */
type CompanionRelayAccountStatus = Pick<CompanionRelayStatus, 'account' | 'accountError'>;

interface CompanionRelayAccountHandle {
  stop(): Promise<void>;
  /** 暂停当前 socket，保留登录订阅。进程退出用 stop()，那个不能再启动。 */
  suspend(): Promise<void>;
  resume(): void;
  revoke(deviceId: string): void;
  status(): CompanionRelayAccountStatus;
  relayRoute(deviceRef: string): CompanionRelayRouteRef | null;
  respondPair(requestId: string, approve: boolean): boolean;
  connected(): boolean;
  dialing(): boolean;
}

/**
 * 账号通道（N-COMPANION-RELAY-ACCOUNT-BIND 第一刀）：电脑登录了 Neo 账号就再开一条 relay 连接，用
 * Supabase access token 鉴权、按 acct:<用户 id> 派生路由并登记。与共享凭据通道完全并行，那条一字不改；
 * 本刀不下发给手机，只让 relay 侧的离线验签与账号路由在生产里有真实消费方。
 * 登录 / 退出 / 换账号时按用户 id 起停；同一用户的令牌刷新不重连（每次拨号现取令牌）——
 * 例外：上次身份加载失败会回退已记的用户 id，同一用户的下一次登录态变化会重试。
 * 总闸暂停走 suspend/resume：不把句柄标成最终停止，同一用户重新拨号时不把本地票据清掉。
 */
export function startCompanionRelayAccountIfConfigured(opts: {
  dataDirectory: string;
  gateway: CompanionGateway;
  loadIdentity: () => Promise<KeyPair>;
  auth: CompanionRelayAccountSource;
  logger?: CompanionRelayLogger;
  now?: () => number;
  jitter?: () => number;
  WebSocket?: typeof WebSocket;
  /** register 自报的电脑名（缺省 os.hostname()）；list-hosts 列表行显示用。 */
  hostName?: string;
  /** relay 找回配对（N-COMPANION-RELAY-ACCOUNT-RECOVER）：桌面卡片的到达与消账广播。 */
  onPairRequest?: (request: CompanionRelayPairRequest) => void;
  onPairSettled?: (requestId: string) => void;
  /** 找回配对完成时新设备的授权范围（与 LAN 邀请同一取值面：全部项目的 grant）。 */
  pairScope?: () => string[];
  /** 旧路由（含共享凭据）取值回调：配对载荷的 relay.routes.legacy，从共享凭据通道取。 */
  pairLegacyRoute?: (deviceId: string) => CompanionRelayRoute | null;
  /** 配对载荷里的 LAN 地址三件套（与二维码邀请同源）；LAN 面没开时缺席。 */
  pairLanAdvertisement?: () => { endpoint: string; altEndpoint: string | null; candidates: string[] } | null;
  /** 电脑当前登录的 Neo 账号邮箱（配对载荷的 welcome 等值内容）。 */
  hostAccountEmail?: () => string | null;
}): CompanionRelayAccountHandle {
  const idle: CompanionRelayAccountHandle = {
    status: () => ({ account: 'off' }),
    revoke: () => {},
    relayRoute: () => null,
    respondPair: () => false,
    stop: async () => {},
    suspend: async () => {},
    resume: () => {},
    connected: () => false,
    dialing: () => false,
  };
  // 共享凭据通道已按同一份配置记过缺失/非法的日志，这里不重复记。
  const config = loadCompanionRelayConfig(opts.dataDirectory);
  // 没配中继：账号通道根本不起，但句柄仍自报 off，调用方不必特判 null。
  if (!config) return idle;
  let client: CompanionRelayClient | null = null;
  let userId: string | null = null;
  let stopped = false;
  let suspended = false;
  /** 暂停期间的登录态。undefined 表示暂停后没有新的登录事件。 */
  let heldUser: { id: string } | null | undefined;
  let chain = Promise.resolve();
  const follow = (user: { id: string } | null) => {
    if (stopped) return;
    if (suspended) {
      heldUser = user;
      return;
    }
    const next = user?.id ?? null;
    // 同一用户且 socket 还在：令牌刷新不重连。已经登出（两边都是 null）也不再空跑一趟。
    // 暂停之后 client 被清空，同一用户要重新走进来，而且不能顺手把票据清掉。
    if (next === userId && (client || next === null)) return;
    const previous = userId;
    userId = next;
    chain = chain.then(async () => {
      await client?.stop();
      client = null;
      // 登出/换账号（本通道上一个绑定的用户没了或换了）必须作废本地票据：那是一张 30 天、能直接
      // 以 acct:<原 sub> 连 relay 的 bearer 凭据，relay 侧没有按账号吊销的通道（全局作废只有删密钥
      // 文件一档＝连带作废所有账号），退出后只能由 Host 自己销毁。session 在 OS Keychain、登出即
      // 销毁，令牌那边本来就没口子。初始登录（previous 为 null，本通道没有可作废的旧绑定）不清：
      // 重启后要先读盘上票据接上（supabase 不通也能连），死票由 1005 拒收路径自己作废。
      // 同一用户重新拨号（暂停后再打开）也不清。进程关停（stop()）不走这条链，也不清。
      if (previous !== null && previous !== next) clearCompanionRelayTicket(opts.dataDirectory);
      if (stopped || suspended || !next || userId !== next) return;
      let identity: KeyPair;
      try {
        identity = await opts.loadIdentity();
      } catch (error) {
        opts.logger?.warn(`Companion relay (account) identity load failed: ${errorHead(error)}; retrying on next auth change`);
        // 身份加载失败后 follow 链里没有自动重试，把 userId 回退掉，让同一用户的下一次登录态
        // 变化（token 刷新/后台 session 验证/重新登录都会发）能重新走这条链——否则设置页的
        // connecting 文案宣称「稍后自动重试」就成了假话。被更新的登录态顶掉时不能回退。
        if (userId === next) userId = null;
        return;
      }
      if (stopped || suspended || userId !== next) return;
      // 票据存取绑定当前账号 id：换了账号登录，旧账号的票据读不出来（sub 对不上），回落令牌拨号。
      const ticket: CompanionRelayTicketStore = {
        load: () => loadCompanionRelayTicket(opts.dataDirectory, next, opts.now),
        store: issued => {
          try {
            if (storeCompanionRelayTicket(opts.dataDirectory, issued, next)) {
              logCompanionRelayInfo(opts.logger, 'Companion relay (account) ticket stored');
            } else {
              // 形状不对 / sub 不是当前账号：与落盘失败分开记，排障时能分清是哪一半没成。
              opts.logger?.warn('Companion relay (account) ticket not stored: malformed or wrong account');
            }
          } catch (error) {
            // 磁盘满/只读等落盘失败：不接住会被 socket.on('message') 的 catch {} 吞成零日志，
            // 行为静默退回「每次拨号都要 supabase」（错题本：降级路径必须留痕）。
            opts.logger?.warn(`Companion relay (account) ticket store failed: ${errorHead(error)}`);
          }
        },
        clear: () => clearCompanionRelayTicket(opts.dataDirectory),
      };
      const started = new CompanionRelayClient({
        gateway: opts.gateway,
        identity,
        config,
        credential: () => opts.auth.getAccessToken(),
        namespace: `acct:${next}`,
        ticket,
        hostName: opts.hostName,
        onPairRequest: opts.onPairRequest,
        onPairSettled: opts.onPairSettled,
        pairScope: opts.pairScope,
        pairLegacyRoute: opts.pairLegacyRoute,
        pairLanAdvertisement: opts.pairLanAdvertisement,
        hostAccountEmail: opts.hostAccountEmail,
        now: opts.now,
        jitter: opts.jitter,
        WebSocket: opts.WebSocket,
        logger: opts.logger,
      });
      client = started;
      await started.start();
      if (stopped || suspended || userId !== next) {
        await started.stop();
        if (client === started) client = null;
      }
    });
  };
  const unsubscribe = opts.auth.addAuthChangeCallback(follow);
  follow(opts.auth.getCurrentUser());
  return {
    revoke: deviceId => client?.revoke(deviceId),
    // 没登录/follow 链还没落地时 client 为 null ⇒ 没有账号路由；token 确定性派生，socket 断着也照给。
    relayRoute: deviceRef => client?.relayRoute(deviceRef) ?? null,
    respondPair: (requestId, approve) => client?.respondPair(requestId, approve) ?? false,
    // 判定顺序即优先级：没登录必然没起 client（follow 会停它），先查 user 不会把登出误报成 connecting。
    // 暂停期间 client 为空、人还登录着：状态枚举没有 paused，仍报 connecting。总闸本身另有 remoteEnabled。
    status: (): CompanionRelayAccountStatus => {
      if (!opts.auth.getCurrentUser()) return { account: 'signedOut' };
      if (client?.connected) return { account: 'connected' };
      // 已登录、账号通道未连上：含 follow 链未落地（client 还没建）与拨号退避中两种情况，都算开通中。
      const accountError = client?.lastDialError;
      return accountError ? { account: 'connecting', accountError } : { account: 'connecting' };
    },
    suspend: async () => {
      if (stopped) return;
      suspended = true;
      await chain;
      await client?.stop();
      client = null;
    },
    resume: () => {
      if (stopped || !suspended) return;
      suspended = false;
      const user = heldUser !== undefined ? heldUser : opts.auth.getCurrentUser();
      heldUser = undefined;
      follow(user);
    },
    connected: () => !stopped && !suspended && client?.connected === true,
    dialing: () => !stopped && !suspended && client?.dialing === true,
    stop: async () => {
      stopped = true;
      unsubscribe();
      await chain;
      await client?.stop();
      client = null;
    },
  };
}
