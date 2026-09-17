import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';

/**
 * LAN/relay 握手里「电脑身份变了」——重连救不回来，必须重新扫码。
 * 不能落成 connectionFailed（「电脑没回应」）否则前台退避会无限重试。
 */
const HANDSHAKE_RESCAN_CODES = new Set([
  'COMPANION_HOST_KEY_MISMATCH',
  'COMPANION_BINDING_CHANGED',
]);

export function handshakeNeedsRescan(code: string): boolean {
  return HANDSHAKE_RESCAN_CODES.has(code);
}

/** 这些连接态不能自愈：配对撤销 / 需重扫 / 本机存储出错。 */
export function connectionBlocksAutoRetry(status: string, connectionError: string | null): boolean {
  if (status === 'rejected' || status === 'storageError' || status === 'unpaired' || status === 'connected') return true;
  return connectionError === 'connectionRejected'
    || connectionError === 'connectionQrInvalid'
    || connectionError === 'connectionScanFailed';
}

/**
 * 下一次重试前要等多久。`failedAttempts` 是本轮已经失败的次数（第一次失败后 = 1 → 2s）。
 * 累计满 10 分钟后无论档位都改 60s。
 */
export function phoneReconnectDelayMs(failedAttempts: number, elapsedMs: number): number {
  if (elapsedMs >= L.phoneReconnectSlowAfterMs) return L.phoneReconnectSlowMs;
  if (failedAttempts <= 0) return 0;
  const steps = L.phoneReconnectBackoffMs;
  return steps[Math.min(failedAttempts - 1, steps.length - 1)] ?? L.phoneReconnectSteadyMs;
}

/** ±50% 抖动；0 延迟不加抖，避免「立即」变成正的等待。 */
export function phoneReconnectJitterMs(delayMs: number, random: () => number = Math.random): number {
  if (delayMs <= 0) return 0;
  return Math.round(delayMs * (0.5 + random()));
}
