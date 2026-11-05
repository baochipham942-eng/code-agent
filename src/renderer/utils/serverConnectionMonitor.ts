// ============================================================================
// Server Connection Monitor — 后台服务死亡期间的「重连中」状态机
// ============================================================================
// N-WEBSERVER-DEATH-SUPERVISE-BANNER。壳（webserver_supervise.rs）负责把挂掉的
// webServer 拉起来；renderer 这份监视器只负责用户可感知层：
//   - 任一传输路径出现「网络层失败」（fetch 拒绝、无 HTTP 响应）→ 开始探测 /api/health
//   - 连续 WEB_SERVER_CONNECTION_MONITOR.FAILURES_BEFORE_BANNER 次探测失败 → recovering（出横幅）
//   - 出事超过 UNAVAILABLE_AFTER_MS 仍不可达 → unavailable（横幅升级 + 重试按钮）
//   - 横幅出过之后的第一次探测成功 → ok + 每次故障恰好一次 location.reload()
//     （刷新拿新 boot/auth 状态，与壳恢复后的导航同口径；用页内标记防刷新环）
//   - 横幅阈值之前就成功 → 静默回 ok，不出横幅、不刷新（短抖动不打扰用户）
//
// 探测「成功」的判定是 fetch 正常 resolve（任意 HTTP 状态码）：/api/health 能应答
// 就说明 webServer 进程活着，死亡才是这里要发现的事；HTTP 4xx/5xx 不触发本监视器
// （那是业务错误，走各自的错误通道）。
// ============================================================================

import {
  WEB_SERVER_CONNECTION_MONITOR,
  WEB_SERVER_DEFAULTS,
} from '@shared/constants';
import { getApiBaseUrl } from '../api/transport';
import { languages } from '../i18n';
import { useAppStore } from '../stores/appStore';
import {
  getServerConnectionStatus,
  useServerConnectionStore,
} from '../stores/serverConnectionStore';

/** 本轮故障内是否已经刷新过一次——「每次故障恰好一次 reload」的防环标记。 */
let reloadedForOutage = false;
/** 探测循环是否在跑（ok 态不打扰，也不该有定时器）。 */
let probing = false;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
/** 在飞探测的序号：新的探测开始时 +1，旧回调按它自弃（重试/停表后不误收口）。 */
let probeSequence = 0;
let outageStartedAt = 0;
let consecutiveProbeFailures = 0;

function clearProbeTimer(): void {
  if (probeTimer !== null) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

function reloadPageOnce(): void {
  if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') {
    return;
  }
  window.location.reload();
}

/**
 * 单次探测。async 包一层保证绝不同步抛（getApiBaseUrl 在 stub window 下可能 throw，
 * 这里吞成 false）——探测失败是预期结果，任何异常都不许冒泡回触发它的传输路径。
 */
function probeHealth(): Promise<boolean> {
  const attempt = async (): Promise<boolean> => {
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(),
      WEB_SERVER_CONNECTION_MONITOR.PROBE_TIMEOUT_MS,
    );
    try {
      await fetch(`${getApiBaseUrl()}${WEB_SERVER_DEFAULTS.HEALTH_PATH}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(abortTimer);
    }
  };
  return attempt().catch(() => false);
}

function handleProbeOutcome(reachable: boolean): void {
  if (!probing) return;
  if (reachable) {
    const bannerWasShown = getServerConnectionStatus() !== 'ok';
    stopProbing();
    if (bannerWasShown) {
      useServerConnectionStore.getState().setStatus('ok');
      if (!reloadedForOutage) {
        reloadedForOutage = true;
        reloadPageOnce();
      }
    }
    return;
  }
  consecutiveProbeFailures += 1;
  const status = getServerConnectionStatus();
  if (
    status === 'ok'
    && consecutiveProbeFailures >= WEB_SERVER_CONNECTION_MONITOR.FAILURES_BEFORE_BANNER
  ) {
    useServerConnectionStore.getState().setStatus('recovering');
  } else if (
    status === 'recovering'
    && Date.now() - outageStartedAt >= WEB_SERVER_CONNECTION_MONITOR.UNAVAILABLE_AFTER_MS
  ) {
    useServerConnectionStore.getState().setStatus('unavailable');
  }
}

/** 单次探测：跑在飞探测，收口后若仍在故障中则按固定间隔排下一发。 */
function runProbe(): void {
  const runId = ++probeSequence;
  void probeHealth().then((reachable) => {
    if (runId !== probeSequence || !probing) return;
    handleProbeOutcome(reachable);
    if (probing) {
      clearProbeTimer();
      probeTimer = setTimeout(runProbe, WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    }
  });
}

function startProbing(): void {
  probing = true;
  reloadedForOutage = false;
  consecutiveProbeFailures = 0;
  outageStartedAt = Date.now();
  useServerConnectionStore.getState().setStatus('ok');
  // 首次上报立即探测（从出错到看见横幅的窗口由它决定），之后按固定间隔。
  runProbe();
}

function stopProbing(): void {
  probing = false;
  probeSequence += 1; // 使在飞的旧回调失效
  clearProbeTimer();
}

/**
 * 传输层「网络失败」上报口（SSE onerror / invoke fetch 拒绝 / /api/run fetch 拒绝）。
 * 幂等：探测已在跑时是 no-op；探测成功会自然停表。HTTP 4xx/5xx 不许调这里。
 */
export function reportServerUnreachable(): void {
  if (!probing) startProbing();
}

/** 「重试」按钮的立即探测：不等当前间隔走完，也不重置故障计时（30s 口径不变）。 */
export function retryNow(): void {
  if (!probing) return;
  clearProbeTimer();
  runProbe();
}

/** /api/run 网络失败时替代裸 `Load failed` 的人话文案（跟随当前语言设置）。 */
export function getServerReconnectingMessage(): string {
  return languages[useAppStore.getState().language].serverConnection.sendRetryHint;
}
