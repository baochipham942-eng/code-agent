// ============================================================================
// modelOverrideErrorCopy - 模型覆盖加载/清除失败 toast 的人话原因句
// ============================================================================
// FB-746：浏览器侧原始错误（"Load failed" / "Failed to fetch"）是工程黑话，
// 不许直接拼进用户 toast。这里把失败原因归成一句可行动的人话；
// 原始 message 不进 toast，排错靠 res.error / err 在调用处的 console 记录。

const NETWORK_FAILURE_PATTERN = /load failed|failed to fetch|networkerror|timed? ?out/i;

/**
 * 模型覆盖失败 toast 的原因句：网络类给下一步，其余统一「请稍后重试」。
 * 永不返回原始 message——调用方只负责拼「加载/清除模型覆盖失败：<原因>」。
 */
export function modelOverrideFailureReason(raw: unknown): string {
  const message = typeof raw === 'string'
    ? raw
    : raw instanceof Error
      ? raw.message
      : null;
  if (message && NETWORK_FAILURE_PATTERN.test(message)) return '网络不通，请检查网络后重试';
  return '请稍后重试';
}
