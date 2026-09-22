// ============================================================================
// 推理客户端超时/重试助手（issue #1989）
// aiSdkAdapter 是 god-file（max-lines 1000 守门），per-request 超时 guard、
// 超时错误构造与 InferenceOptions.onInferenceRetry 的事件拼装收在这里，
// adapter 每个调用点一行。
// ============================================================================

import type { InferenceOptions, InferenceRetryInfo } from '../types';
import type { ModelConfig } from '../../../shared/contract';

const INFERENCE_CLIENT_TIMEOUT_CODE = 'INFERENCE_REQUEST_TIMEOUT';

/** withTransientRetry 的 isTimeoutError：只认本适配器整请求超时（首字节/间隔看门狗在流式路径单独计数）。 */
export function isInferenceClientTimeoutError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === INFERENCE_CLIENT_TIMEOUT_CODE;
}

/** 非流式整请求超时错误：文案保留 'timeout of '（retryStrategy 瞬态模式据此判可重试），code 供超时重试单独计数。 */
export function makeInferenceClientTimeoutError(requestTimeoutMs: number, cause: unknown): Error {
  return Object.assign(
    new Error(`timeout of ${requestTimeoutMs}ms exceeded`),
    { code: INFERENCE_CLIENT_TIMEOUT_CODE, cause },
  );
}

// 给一次 provider 调用套 per-request 超时：组合「外部 signal + 内部超时」成一个 abortSignal。
// AI SDK 走 fetch 默认无请求超时，旧 axios 路径有 PROVIDER_TIMEOUT，迁移时丢了——provider 偶发
// 卡住（接受连接但响应不返回）会一直挂到外层预算耗尽（子代理 90s 硬超时），无 per-request 早退+重试。
// 用自管 setTimeout（可被 fake timers 控制，区别于 AbortSignal.timeout）；timedOut() 让调用方区分
// 「本超时（应重试）」与「外部 abort（父/预算取消，不应重试）」。
export function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    timedOut: () => controller.signal.aborted,
    cleanup: () => clearTimeout(timer),
  };
}

/** 非流式 withTransientRetry onRetry → 会话级 trace 回调。 */
export function notifyGenerateRetry(
  options: InferenceOptions | undefined,
  config: ModelConfig,
  info: { provider: string; attempt: number; maxRetries: number; delay: number; error: string },
): void {
  options?.onInferenceRetry?.({
    provider: info.provider,
    model: config.model,
    attempt: info.attempt,
    maxRetries: info.maxRetries,
    delayMs: info.delay,
    kind: info.error.startsWith('timeout of ') ? 'timeout' : 'transient',
    error: info.error,
  });
}

/** 流式首字节前重试 / 断流续接 → 会话级 trace 回调。 */
export function notifyStreamRetry(
  options: InferenceOptions | undefined,
  config: ModelConfig,
  info: { attempt: number; maxRetries: number; delayMs: number; kind: InferenceRetryInfo['kind']; error: string },
): void {
  options?.onInferenceRetry?.({ provider: config.provider, model: config.model, ...info });
}
