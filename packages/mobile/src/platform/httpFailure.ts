/**
 * 原生 HTTP 失败 → 协议错误码（fix4-②）。此前 CapacitorHttp 一切失败都折叠成
 * COMPANION_NETWORK_UNAVAILABLE，「电脑上的 Neo 没在运行」和「电脑在睡眠」对用户是
 * 两件不同的事，修法不同。
 *
 * 信号源（Capacitor 8.5 原生侧实测形状）：
 * - Android `HttpRequestHandler` 以 `call.reject(localizedMessage, e.getClass().getSimpleName())`
 *   拒绝——code 是异常类名（ConnectException / SocketTimeoutException），message 里带
 *   ECONNREFUSED / timeout 字样。
 * - iOS `HttpRequestHandler` 以 `call.reject(localizedDescription, nsErrorDomain)` 拒绝——
 *   code 只有 domain 区分不出具体码，按 URLSession 的固定文案分。
 * 分不出的（新文案 / 系统怪话）回退 COMPANION_NETWORK_UNAVAILABLE：诊断句落到
 * 「电脑没回应」那一类，不会更错。
 */
export type HttpFailureCode = 'COMPANION_CONNECTION_REFUSED' | 'COMPANION_NO_RESPONSE' | 'COMPANION_NETWORK_UNAVAILABLE';

export function classifyHttpFailure(error: unknown): HttpFailureCode {
  const code = error != null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  const message = error instanceof Error ? error.message
    : error != null && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message)
      : String(error ?? '');
  // 连接被拒绝：宿主在网但端口没人听（RST）——Neo 没在运行。
  if (code === 'ConnectException' || /ECONNREFUSED/i.test(message)) return 'COMPANION_CONNECTION_REFUSED';
  if (/could not connect to the server/i.test(message)) return 'COMPANION_CONNECTION_REFUSED';
  // 超时/无响应：connect/read 超时。
  if (code === 'SocketTimeoutException' || code === 'TimeoutException' || /timed?\s*out|timeout/i.test(message)) return 'COMPANION_NO_RESPONSE';
  return 'COMPANION_NETWORK_UNAVAILABLE';
}
