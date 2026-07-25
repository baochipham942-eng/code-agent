// ============================================================================
// useStaleGuardedLoadingSet — 每个 id 独立 loading + 代际防陈旧覆盖（A5）
// ============================================================================
//
// MCP 安装/启用是并发点：不同 entry 可以同时在飞，同一 entry 也可能被快速二次
// 触发（如取消后立刻重试）。单值 loading（`string | null`）会被先返回的旧
// promise 的 finally 提前清掉——不管那到底是不是当前这次操作。
// 本 hook 用 Set 隔离不同 id 的 loading，用代际计数器隔离同一 id 的新旧操作：
// 只有仍是"最新一次"发起的操作，它的 finally 才允许清 loading / 写入结果。

import { useCallback, useRef, useState } from 'react';

export function useStaleGuardedLoadingSet() {
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const generationRef = useRef<Map<string, number>>(new Map());

  const begin = useCallback((id: string): number => {
    const generation = (generationRef.current.get(id) ?? 0) + 1;
    generationRef.current.set(id, generation);
    setLoading((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    return generation;
  }, []);

  const isStale = useCallback((id: string, generation: number): boolean => (
    generationRef.current.get(id) !== generation
  ), []);

  const end = useCallback((id: string, generation: number) => {
    if (generationRef.current.get(id) !== generation) return;
    setLoading((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return { loading, begin, end, isStale };
}
