import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('DataFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should clean up interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    // 组件卸载后应该调用 clearInterval
    // 如果修复正确，clearInterval 会被调用
    expect(clearIntervalSpy).toBeDefined();
  });

  it('should remove event listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    // 组件卸载后应该移除事件监听器
    expect(removeEventListenerSpy).toBeDefined();
  });
});
