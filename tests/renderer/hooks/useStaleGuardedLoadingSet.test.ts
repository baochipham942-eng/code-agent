// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStaleGuardedLoadingSet } from '../../../src/renderer/hooks/useStaleGuardedLoadingSet';

describe('useStaleGuardedLoadingSet（A5 · MCP 安装 stale-promise 防护）', () => {
  it('不同 id 并发在飞：先完成的那个不清掉仍在飞的另一个的 loading', () => {
    const { result } = renderHook(() => useStaleGuardedLoadingSet());

    let genA = 0;
    let genB = 0;
    act(() => { genA = result.current.begin('server-a'); });
    act(() => { genB = result.current.begin('server-b'); });
    expect(result.current.loading.has('server-a')).toBe(true);
    expect(result.current.loading.has('server-b')).toBe(true);

    // server-a 先返回（旧行为会调用全局 setDiscoverActionLoading(null) 把 b 也清掉）
    act(() => { result.current.end('server-a', genA); });
    expect(result.current.loading.has('server-a')).toBe(false);
    expect(result.current.loading.has('server-b')).toBe(true); // b 必须仍在飞

    act(() => { result.current.end('server-b', genB); });
    expect(result.current.loading.has('server-b')).toBe(false);
  });

  it('同一 id 快速二次触发：旧一轮（取消后重试场景）的 end 不清掉新一轮的 loading，且判定为 stale', () => {
    const { result } = renderHook(() => useStaleGuardedLoadingSet());

    let firstGen = 0;
    let secondGen = 0;
    act(() => { firstGen = result.current.begin('server-x'); }); // 第一次点击
    act(() => { secondGen = result.current.begin('server-x'); }); // 用户没等第一次返回就再点了一次
    expect(secondGen).not.toBe(firstGen);
    expect(result.current.loading.has('server-x')).toBe(true);

    // 第一次（旧）的 promise 才姗姗来迟——必须被判定为 stale，且不能清 loading
    expect(result.current.isStale('server-x', firstGen)).toBe(true);
    act(() => { result.current.end('server-x', firstGen); });
    expect(result.current.loading.has('server-x')).toBe(true); // 新一轮仍在飞，不能被旧的清掉

    // 第二次（当前这一轮）返回时才是真正结束
    expect(result.current.isStale('server-x', secondGen)).toBe(false);
    act(() => { result.current.end('server-x', secondGen); });
    expect(result.current.loading.has('server-x')).toBe(false);
  });
});
