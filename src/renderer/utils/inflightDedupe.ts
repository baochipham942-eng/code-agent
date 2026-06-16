// ============================================================================
// inflightDedupe — 把「同一时刻在途的相同请求」合并成一个 Promise。
//
// 解决挂载期重复请求：首屏 16 个组件各自 useEffect 直接拉 settings/get 等，
// 同一 key 的并发请求实际只需打一次后端。注意：仅做「在途去重」，请求 settle
// 后立即清除（不做 TTL 缓存），所以不会读到陈旧数据 —— 保存后再读仍是新值。
// ============================================================================

/**
 * 包装一个异步函数，使「在途期间」相同 key 的并发调用共享同一个 Promise。
 *
 * @param fn    被包装的异步函数
 * @param keyOf 由入参计算去重 key；返回 null 表示该调用不参与去重（如写操作）
 */
export function createInflightDedupe<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  keyOf: (...args: Args) => string | null,
): (...args: Args) => Promise<R> {
  const inflight = new Map<string, Promise<R>>();

  return (...args: Args): Promise<R> => {
    const key = keyOf(...args);
    if (key === null) {
      return fn(...args);
    }
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }
    // settle（成功或失败）后即清除，避免缓存失败结果或陈旧数据
    const promise = fn(...args).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  };
}
