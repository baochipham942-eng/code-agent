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

/** SDK 凭据类错误：pullConnectConfig 拿到非零 code，重试无意义 */
const CREDENTIAL_FAILURE_PATTERN = /pullConnectConfig/i;
/** 超时 / 网络类错误：换个人话，重试有意义 */
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

/**
 * 把连接失败的原始错误文本翻成用户能懂的中文（设置页 errorMessage 用）。
 * 原始英文只留在 logger；三类出口都不回传原文，天然不带敏感串。
 */
export function channelConnectFailureText(raw: string, channelLabel: string): string {
  const text = raw || '';
  if (CREDENTIAL_FAILURE_PATTERN.test(text)) {
    return CREDENTIAL_FAILURE_TEXT;
  }
  if (NETWORK_FAILURE_PATTERN.test(text)) {
    return `连不上${channelLabel}服务器，正在自动重试`;
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
   */
  private async probePendingAccounts(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      for (const [accountId, state] of Array.from(this.retries.entries())) {
        if (!state.timer) continue;
        const host = this.options.probeHostFor(accountId);
        if (!host) continue;
        let lookupOk = false;
        try {
          await lookup(host);
          lookupOk = true;
        } catch {
          lookupOk = false;
        }
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
}
