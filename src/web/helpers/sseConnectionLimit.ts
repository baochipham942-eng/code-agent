// ============================================================================
// web SSE per-token 并发连接限流（WP3-4）。
//
// rateLimit 中间件是滑动窗口请求计数，对挂几小时的 SSE 长连接只算 1 次请求，
// 挡不住"开着不关"的连接堆积——须按当前并发数设闸。fail-closed：超限直接拒
//（不排队，SSE 连接本身就是要长期占用，排队无意义），且必须在 writeHead 之前
// 拒绝（text/event-stream 头一旦写出就无法再改状态码回 429）。
//
// 释放走双保险（res 'close' 监听 + handler finally），release 幂等保证一次
// acquire 恰好对应一次递减，双路触发不会把配额放大。
// ============================================================================
import type { Request } from 'express';
import { WEB_SSE } from '../../shared/constants';

export class SseConnectionLimiter {
  /** key（token）→ 当前活跃连接数；归零删 key 防 Map 泄漏。 */
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerKey: number) {}

  /** 成功返回幂等 release 函数；超限返回 null（fail-closed 拒绝）。 */
  tryAcquire(key: string): (() => void) | null {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.maxPerKey) return null;
    this.counts.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = this.counts.get(key) ?? 0;
      if (now <= 1) this.counts.delete(key);
      else this.counts.set(key, now - 1);
    };
  }

  /** 当前有活跃连接的 key 数（观测/测试用）。 */
  activeKeys(): number {
    return this.counts.size;
  }
}

/**
 * 提取请求的 auth token 作为并发计数 key（与 authMiddleware 同口径：Bearer 头或
 * ?token= query）。生产链路 authMiddleware 挂在本路由之前，走到 handler 必有合法
 * token；无 token（仅测试/直连场景）归入共享 anon 桶，同样受上限约束不放行无界连接。
 */
export function extractRequestToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return 'anon';
}

/** /api/run SSE 共享限流器单例。 */
export const agentRunSseLimiter = new SseConnectionLimiter(WEB_SSE.MAX_CONCURRENT_PER_TOKEN);
