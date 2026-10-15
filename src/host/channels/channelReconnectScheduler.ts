// ============================================================================
// Channel Reconnect Scheduler - 通道账号连接失败的自动重连调度
// ----------------------------------------------------------------------------
// ChannelManager 在 connectAccount 失败后把账号交给这里：按账号指数退避
// （30s 起步、翻倍、15 分钟封顶、次数不限），并在系统唤醒（tick 墙钟差探测）
// 或平台域名 DNS 探测由败转成时立即重试一次。所有 timer 都 unref，shutdown
// / 手动断开时清理。用户手动断开的账号由调用方 cancel，这里不持有账号语义。
// ============================================================================

import { lookup } from 'node:dns/promises';
import { createLogger } from '../services/infra/logger';
import {
  CHANNEL_CONNECT_RETRY,
  CHANNEL_CONNECT_RETRY_INITIAL_MS_ENV,
  CHANNEL_RECOVERY_PROBE,
} from '../../shared/constants';

const logger = createLogger('ChannelReconnect');

export type ChannelReconnectTrigger = 'backoff' | 'wake' | 'network';

export interface ChannelReconnectOptions {
  /** 重试到点回调（同步入口，调用方自行异步收尾并驱动下一轮 schedule） */
  onRetry: (accountId: string, attempt: number, trigger: ChannelReconnectTrigger) => void;
  /** 账号挂起重试期间要 DNS 探测的平台域名；无则该账号只参与唤醒检测 */
  probeHostFor: (accountId: string) => string | undefined;
  /** 退避起始毫秒（测试/联调经 env 覆盖时由调用方显式传入） */
  initialDelayMs?: number;
  maxDelayMs?: number;
  probeIntervalMs?: number;
  wakeGapFactor?: number;
}

interface RetryState {
  /** 即将进行的重试序号（第 N 次），从 1 起 */
  attempt: number;
  timer: NodeJS.Timeout | null;
  /** 上一次 DNS 探测是否成功；null = 尚无数据（不做翻转判定） */
  lastLookupOk: boolean | null;
}

/**
 * 连接失败按「失败种类」分类（r3 rework），而不是看某一条消息的子串：
 * - transient：瞬时失败（网络/超时/平台忙/连接数超限）→ 退避重试
 * - credentials：凭据/权限类 → 停在 error，提示检查凭据
 * - permanent：其余永久失败（端口占用、未知平台码…）→ 停在 error，不重放同一配置
 */
type ChannelConnectFailureKind = 'transient' | 'credentials' | 'permanent';

/** SDK WSClient.pullConnectConfig 的终态错误原文：`pullConnectConfig failed: code=${code}, msg=${reason}` */
const PULL_CONFIG_FAILURE = /pullConnectConfig failed: code=(-?\d+), msg=([\s\S]*)/i;
/**
 * SDK ErrorCode 枚举里的平台侧瞬时码：system_busy=1、exceed_conn_limit=1000040350。
 * SDK 对它们 retryable:false，但失败与本地凭据无关：平台恢复 / 连接数降下来即可
 * 连上，重放同一份凭据有意义。
 */
const TRANSIENT_PULL_CODES: ReadonlySet<number> = new Set([1, 1000040350]);
/** SDK ErrorCode 枚举里的鉴权类码：forbidden=403、auth_failed=514 */
const AUTH_PULL_CODES: ReadonlySet<number> = new Set([403, 514]);
/** 枚举外未知非零码按 msg 里的凭据字样兜底归类（如 code=10003, msg=app secret is invalid） */
const AUTH_MSG_PATTERN = /secret|app_?id|auth|token|permission|forbidden/i;
/** 令牌/凭据被服务端拒绝（如 grammY 401）：重放同一凭据没有意义 */
const AUTH_FAILURE_PATTERN = /\b401\b|unauthorized|invalid[_ ]token/i;
/** 超时 / 网络类错误：重试有意义 */
const NETWORK_FAILURE_PATTERN = new RegExp(
  [
    'handshake timeout',
    'timed?\\s?out',
    'timeout',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ENETUNREACH',
    'ENETDOWN',
    'EHOSTUNREACH',
    'EHOSTDOWN',
    'EADDRNOTAVAIL',
    'EPIPE',
    'EPROTO',
    'EAI_AGAIN',
    'fetch failed',
    'network',
    'socket hang up',
    'connect failed',
    'unable to connect',
    'reconnect exhausted',
  ].join('|'),
  'i',
);

const CREDENTIAL_FAILURE_TEXT = '飞书应用凭据或权限有误，请检查 App ID 和 App Secret';

interface ConnectFailureClass {
  kind: ChannelConnectFailureKind;
  /** pullConnectConfig 失败携带的平台非零码（文案用） */
  pullCode?: number;
}

function classifyConnectFailure(raw: string): ConnectFailureClass {
  const text = raw || '';
  const pull = PULL_CONFIG_FAILURE.exec(text);
  if (pull) {
    const code = Number.parseInt(pull[1] ?? '', 10);
    if (TRANSIENT_PULL_CODES.has(code)) return { kind: 'transient', pullCode: code };
    if (AUTH_PULL_CODES.has(code) || AUTH_MSG_PATTERN.test(pull[2] ?? '')) {
      return { kind: 'credentials', pullCode: code };
    }
    return { kind: 'permanent', pullCode: code };
  }
  if (AUTH_FAILURE_PATTERN.test(text)) return { kind: 'credentials' };
  if (/EADDRINUSE/i.test(text)) return { kind: 'permanent' };
  if (NETWORK_FAILURE_PATTERN.test(text)) return { kind: 'transient' };
  // 未知失败默认不重试：无限退避会掩盖永久性配置错误（r3 rework）
  return { kind: 'permanent' };
}

/**
 * 这份失败原文是否值得自动重试：只认瞬时失败（网络/超时/平台忙/连接数超限）。
 * 凭据被拒、端口被占用等永久失败重放同一配置没有意义，manager 层不排退避，
 * 停在 error 等用户处理。
 */
export function isChannelConnectFailureRetryable(raw: string): boolean {
  return classifyConnectFailure(raw).kind === 'transient';
}

/**
 * 把连接失败的原始错误文本翻成用户能懂的中文（设置页 errorMessage 用）。
 * 原始英文只留在 logger；三类出口都不回传原文，天然不带敏感串。
 */
export function channelConnectFailureText(raw: string, channelLabel: string): string {
  const text = raw || '';
  const { kind, pullCode } = classifyConnectFailure(text);
  if (kind === 'transient') {
    if (pullCode === 1000040350) return `${channelLabel}连接数已达上限，正在自动重试`;
    return `连不上${channelLabel}服务器，正在自动重试`;
  }
  if (kind === 'credentials') {
    // pullConnectConfig 鉴权失败是飞书/Lark 应用凭据；其余通道（如 Telegram 401）用通用凭据文案
    if (PULL_CONFIG_FAILURE.test(text)) return CREDENTIAL_FAILURE_TEXT;
    return `${channelLabel}凭据或权限有误，请检查令牌或应用凭据`;
  }
  if (/EADDRINUSE/i.test(text)) return '本地端口被占用，请检查占用进程或更换端口';
  if (pullCode !== undefined) {
    return `连接${channelLabel}失败（平台返回 code=${pullCode}），请检查应用配置`;
  }
  return `连接${channelLabel}失败，请稍后重试或查看本机诊断`;
}

/** 等待重试期间的账号状态文案（沿用 feishuWsSession 里已有的「重连中」措辞） */
export function channelReconnectingStatusText(attempt: number, reason: string): string {
  return `重连中（第 ${attempt} 次）：${reason}`;
}

function envInitialDelayMs(): number | undefined {
  const raw = process.env[CHANNEL_CONNECT_RETRY_INITIAL_MS_ENV];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class ChannelReconnectScheduler {
  private readonly retries = new Map<string, RetryState>();
  private probeTimer: NodeJS.Timeout | null = null;
  private lastTickAt: number | null = null;
  private probing = false;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly probeIntervalMs: number;
  private readonly wakeGapFactor: number;

  constructor(private readonly options: ChannelReconnectOptions) {
    this.initialDelayMs = options.initialDelayMs
      ?? envInitialDelayMs()
      ?? CHANNEL_CONNECT_RETRY.INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? CHANNEL_CONNECT_RETRY.MAX_DELAY_MS;
    this.probeIntervalMs = options.probeIntervalMs ?? CHANNEL_RECOVERY_PROBE.TICK_INTERVAL_MS;
    this.wakeGapFactor = options.wakeGapFactor ?? CHANNEL_RECOVERY_PROBE.WAKE_GAP_FACTOR;
  }

  /**
   * 失败后排下一轮重试，返回重试序号（第 N 次，调用方用于状态文案）。
   * 已有挂起重试时保持既有节奏，不叠加 timer。
   */
  schedule(accountId: string): number {
    const existing = this.retries.get(accountId);
    if (existing?.timer) {
      return existing.attempt;
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    const delayMs = Math.min(this.initialDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    const state: RetryState = { attempt, timer: null, lastLookupOk: existing?.lastLookupOk ?? null };
    this.retries.set(accountId, state);
    state.timer = setTimeout(() => this.fire(accountId, 'backoff'), delayMs);
    state.timer.unref();
    this.ensureProbeLoop();
    logger.info('Channel connect retry scheduled', { accountId, attempt, delayMs });
    return attempt;
  }

  /** 连接成功：取消挂起重试并清零序号 */
  reset(accountId: string): void {
    this.cancel(accountId);
  }

  /** 手动断开 / 更新 / 删除：取消挂起重试（序号随之清零，下次失败从头计数） */
  cancel(accountId: string): void {
    const state = this.retries.get(accountId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    this.retries.delete(accountId);
    this.maybeStopProbeLoop();
  }

  /** 关停：清全部 timer（挂起重试与探测循环） */
  cancelAll(): void {
    for (const state of this.retries.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.retries.clear();
    this.maybeStopProbeLoop();
  }

  private fire(accountId: string, trigger: ChannelReconnectTrigger): void {
    const state = this.retries.get(accountId);
    if (!state?.timer) {
      return;
    }
    clearTimeout(state.timer);
    state.timer = null;
    logger.info('Channel connect retry firing', { accountId, attempt: state.attempt, trigger });
    this.options.onRetry(accountId, state.attempt, trigger);
  }

  private ensureProbeLoop(): void {
    if (this.probeTimer) return;
    this.lastTickAt = Date.now();
    this.probeTimer = setInterval(() => this.onProbeTick(), this.probeIntervalMs);
    this.probeTimer.unref();
  }

  private maybeStopProbeLoop(): void {
    if (this.retries.size > 0 || !this.probeTimer) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
    this.lastTickAt = null;
  }

  private onProbeTick(): void {
    const now = Date.now();
    const wokeUp = this.lastTickAt !== null
      && now - this.lastTickAt > this.probeIntervalMs * this.wakeGapFactor;
    this.lastTickAt = now;
    if (this.retries.size === 0) {
      this.maybeStopProbeLoop();
      return;
    }
    if (wokeUp) {
      logger.info('System wake detected, firing pending channel retries now');
      for (const accountId of Array.from(this.retries.keys())) {
        this.fire(accountId, 'wake');
      }
      return;
    }
    void this.probePendingAccounts();
  }

  /**
   * 轻量 DNS 探测：只对挂起等待（timer 存在）的账号做，失败→成功翻转时
   * 立即重试一次；失败后回到退避节奏（fire 后由调用方失败再 schedule）。
   * 单次 lookup 带兜底超时：一次挂起的 DNS 查询不得让 probing 永远为 true、
   * 停掉网络恢复快路径。
   */
  private async probePendingAccounts(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      for (const [accountId, state] of Array.from(this.retries.entries())) {
        if (!state.timer) continue;
        const host = this.options.probeHostFor(accountId);
        if (!host) continue;
        const lookupOk = await this.probeHostOnce(host);
        const wasOk = state.lastLookupOk;
        state.lastLookupOk = lookupOk;
        if (wasOk === false && lookupOk) {
          logger.info('Network recovery detected, firing channel retry now', { accountId, host });
          this.fire(accountId, 'network');
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private async probeHostOnce(host: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        lookup(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe lookup timeout')), CHANNEL_RECOVERY_PROBE.LOOKUP_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
