// ============================================================================
// Transport 失败登记簿
// ============================================================================
// httpTransport 的通用 invoke 对非 2xx / `{success:false}` / fetch 异常一律静默
// `return undefined`（改返回契约会波及全部 ~200 个 invoke 调用点），调用方拿不到真因，
// UI 只能显示「操作失败」这类哑文案。这里只记录「最近一次失败」：想 fail-loud 的调用方
// 自己来取，其余调用方行为一字不变。
//
// 单独成文件（不挂在 httpTransport 上）是为了让消费方不必 import 整个 transport ——
// transport 会连带拉起 zustand store 等浏览器侧副作用，node 环境的单测会直接炸。
// ============================================================================

export type TransportFailure = {
  channel: string;
  status: number | null;
  message: string;
};

const lastTransportFailures = new Map<string, TransportFailure>();

export function recordTransportFailure(channel: string, status: number | null, message: string): void {
  lastTransportFailures.set(channel, { channel, status, message });
}

/** 取走某通道最近一次失败原因（取走即清，避免旧失败泄漏到后续调用） */
export function takeTransportFailure(channel: string): TransportFailure | undefined {
  const failure = lastTransportFailures.get(channel);
  if (failure) lastTransportFailures.delete(channel);
  return failure;
}
