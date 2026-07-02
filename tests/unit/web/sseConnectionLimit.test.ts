// ============================================================================
// WP3-4 web SSE 防滥用：per-token 并发连接限流器单元契约。
// - tryAcquire 超限返回 null（fail-closed：不排队、不降级放行）
// - release 幂等（close 监听与 finally 双路释放不重复递减）
// - 计数归零删 key（防 Map 泄漏）
// ============================================================================
import { describe, it, expect } from 'vitest';
import { SseConnectionLimiter } from '../../../src/web/helpers/sseConnectionLimit';

describe('SseConnectionLimiter', () => {
  it('未超限 acquire 成功，超限返回 null（拒绝，不排队）', () => {
    const limiter = new SseConnectionLimiter(2);
    expect(limiter.tryAcquire('tok-a')).toBeTypeOf('function');
    expect(limiter.tryAcquire('tok-a')).toBeTypeOf('function');
    expect(limiter.tryAcquire('tok-a')).toBeNull();
  });

  it('不同 key 各自计数', () => {
    const limiter = new SseConnectionLimiter(1);
    expect(limiter.tryAcquire('tok-a')).toBeTypeOf('function');
    expect(limiter.tryAcquire('tok-b')).toBeTypeOf('function');
    expect(limiter.tryAcquire('tok-a')).toBeNull();
  });

  it('release 释放槽位后可再次 acquire', () => {
    const limiter = new SseConnectionLimiter(1);
    const release = limiter.tryAcquire('tok-a');
    expect(release).toBeTypeOf('function');
    release!();
    expect(limiter.tryAcquire('tok-a')).toBeTypeOf('function');
  });

  it('release 幂等：双路释放（close 监听 + finally）不会把计数减成负数放大配额', () => {
    const limiter = new SseConnectionLimiter(1);
    const r1 = limiter.tryAcquire('tok-a');
    r1!();
    r1!(); // 第二次是 no-op
    const r2 = limiter.tryAcquire('tok-a');
    expect(r2).toBeTypeOf('function');
    expect(limiter.tryAcquire('tok-a')).toBeNull(); // 上限仍是 1，没有被双重释放放大
  });

  it('计数归零删 key，activeKeys 不泄漏', () => {
    const limiter = new SseConnectionLimiter(2);
    const r1 = limiter.tryAcquire('tok-a');
    const r2 = limiter.tryAcquire('tok-a');
    expect(limiter.activeKeys()).toBe(1);
    r1!();
    r2!();
    expect(limiter.activeKeys()).toBe(0);
  });
});
