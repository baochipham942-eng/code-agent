import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchComponent } from './data-fetcher.js';

describe('SearchComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should handle rapid searches correctly (race condition test)', async () => {
    const component = new SearchComponent();

    // 模拟不同响应时间的 API 调用
    let resolvers: Array<(value: Response) => void> = [];

    vi.spyOn(global, 'fetch').mockImplementation(() => {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });

    // 快速连续搜索
    const search1 = component.search('a');
    const search2 = component.search('ab');
    const search3 = component.search('abc');

    // 模拟乱序响应：第一个请求最后完成
    // 第三个请求先完成
    resolvers[2]!(new Response(JSON.stringify(['abc-result']), { status: 200 }));
    await vi.runAllTimersAsync();

    // 第二个请求完成
    resolvers[1]!(new Response(JSON.stringify(['ab-result']), { status: 200 }));
    await vi.runAllTimersAsync();

    // 第一个请求最后完成 - 如果有竞态 bug，这会覆盖正确的结果
    resolvers[0]!(new Response(JSON.stringify(['a-result']), { status: 200 }));
    await vi.runAllTimersAsync();

    await Promise.allSettled([search1, search2, search3]);

    // 最终结果应该是最后一次搜索的结果 'abc-result'
    // 如果有竞态 bug，结果会是 'a-result'
    expect(component.getResults()).toEqual(['abc-result']);
  });
});
