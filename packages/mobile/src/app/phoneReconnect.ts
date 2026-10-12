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
 * 连接失败分类（fix4-② 三分类 + relay 档 + 总闸关闭档）：连接层上抛的错误码 → 用户可分辨的
 * `connectionError`，UI 按 connectionDiagnosis 给一句人话。键名与 i18n 表一一对应。
 * 总闸关闭档（N-COMPANION-KILLSWITCH-WIRE）：宿主点名的 COMPANION_REMOTE_OFF 说的是「电脑
 * 关了远程」——host 回过话，不属于离网；配对原样保留，退避自动重试照跑（不进 blocksAutoRetry），
 * 电脑重新打开后手机自愈。
 * 从 companionStore 搬来（store 已过 1000 行上限，净行数不得再涨）。
 */
export type ConnectionErrorCode = 'connectionQrInvalid' | 'connectionScanFailed' | 'connectionRejected' | 'connectionRefused' | 'connectionUnavailable' | 'connectionFailed'
  | 'connectionRelayUnavailable' | 'connectionRelayRejected' | 'connectionRelayNoHost' | 'connectionRemoteOff';

export function connectionErrorFromCode(code: string): ConnectionErrorCode {
  return code === 'COMPANION_INVALID_INVITATION' ? 'connectionQrInvalid'
    : code === 'COMPANION_SCAN_FAILED' ? 'connectionScanFailed'
    : code === 'COMPANION_PAIRING_REJECTED' || handshakeNeedsRescan(code) ? 'connectionRejected'
    : code === 'COMPANION_REMOTE_OFF' ? 'connectionRemoteOff'
    : code === 'COMPANION_CONNECTION_REFUSED' ? 'connectionRefused'
    : code === 'COMPANION_RELAY_AUTH_REJECTED' ? 'connectionRelayRejected'
    : code === 'COMPANION_RELAY_NO_HOST' ? 'connectionRelayNoHost'
    : code === 'COMPANION_RELAY_UNAVAILABLE' || code === 'COMPANION_RELAY_CONNECT_TIMEOUT' ? 'connectionRelayUnavailable'
    : code === 'COMPANION_NETWORK_UNAVAILABLE' || code === 'COMPANION_NO_RESPONSE' ? 'connectionUnavailable' : 'connectionFailed';
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
