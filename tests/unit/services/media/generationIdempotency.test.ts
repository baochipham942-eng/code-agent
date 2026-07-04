// ============================================================================
// GenerationIdempotencyRegistry（WP3-1 成本安全）—— 付费生成 commandId 幂等注册表。
// 覆盖：无 commandId 直通 / 同 commandId 命中缓存不重执行 / 失败不缓存 /
// 并发 in-flight 合并 / validate 失效重执行 / 容量有界逐出 / TTL 过期失效。
// ============================================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GenerationIdempotencyRegistry } from '../../../../src/host/services/media/generationIdempotency';

afterEach(() => {
  vi.useRealTimers();
});

describe('GenerationIdempotencyRegistry', () => {
  it('无 commandId → 每次都执行（保持既有行为）', async () => {
    const reg = new GenerationIdempotencyRegistry();
    const exec = vi.fn().mockResolvedValue({ path: '/a' });
    await reg.run(undefined, exec);
    await reg.run(undefined, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('同 commandId 已有成功结果 → 直接返回缓存产物，不再执行（不再计费）', async () => {
    const reg = new GenerationIdempotencyRegistry();
    const exec = vi.fn().mockResolvedValue({ path: '/out/v1.mp4', costCny: 0.7 });
    const first = await reg.run('gencmd-a', exec);
    const second = await reg.run('gencmd-a', exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('不同 commandId → 各自执行', async () => {
    const reg = new GenerationIdempotencyRegistry();
    const exec = vi.fn().mockResolvedValue({ path: '/x' });
    await reg.run('gencmd-a', exec);
    await reg.run('gencmd-b', exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('执行失败不缓存 → 同 commandId 重试会再执行（失败不该锁死重试）', async () => {
    const reg = new GenerationIdempotencyRegistry();
    const exec = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce({ path: '/ok' });
    await expect(reg.run('gencmd-a', exec)).rejects.toThrow('quota');
    const second = await reg.run('gencmd-a', exec);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ path: '/ok' });
  });

  it('并发同 commandId → in-flight 合并只执行一次，双方拿同一结果', async () => {
    const reg = new GenerationIdempotencyRegistry();
    let resolveExec: (v: { path: string }) => void = () => {};
    const exec = vi.fn().mockImplementation(
      () => new Promise<{ path: string }>((resolve) => { resolveExec = resolve; }),
    );
    const p1 = reg.run('gencmd-a', exec);
    const p2 = reg.run('gencmd-a', exec);
    resolveExec({ path: '/once' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ path: '/once' });
    expect(r2).toEqual({ path: '/once' });
  });

  it('validate 返回 false（缓存产物已失效）→ 重新执行', async () => {
    const reg = new GenerationIdempotencyRegistry();
    const exec = vi.fn()
      .mockResolvedValueOnce({ path: '/gone.mp4' })
      .mockResolvedValueOnce({ path: '/fresh.mp4' });
    await reg.run('gencmd-a', exec, () => false);
    const second = await reg.run('gencmd-a', exec, () => false);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ path: '/fresh.mp4' });
  });

  it('容量有界：超 maxEntries 逐出最旧条目（防内存无界增长）', async () => {
    const reg = new GenerationIdempotencyRegistry({ maxEntries: 2 });
    const exec = vi.fn().mockResolvedValue({ path: '/x' });
    await reg.run('gencmd-1', exec);
    await reg.run('gencmd-2', exec);
    await reg.run('gencmd-3', exec); // 逐出 gencmd-1
    await reg.run('gencmd-1', exec); // 已被逐出 → 重新执行
    expect(exec).toHaveBeenCalledTimes(4);
    await reg.run('gencmd-3', exec); // 仍在缓存 → 不执行
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('TTL 过期 → 缓存失效重新执行', async () => {
    vi.useFakeTimers();
    const reg = new GenerationIdempotencyRegistry({ ttlMs: 1000 });
    const exec = vi.fn().mockResolvedValue({ path: '/x' });
    await reg.run('gencmd-a', exec);
    vi.advanceTimersByTime(1500);
    await reg.run('gencmd-a', exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
