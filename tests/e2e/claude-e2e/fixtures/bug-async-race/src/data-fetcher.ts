interface FetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// Bug: 存在竞态条件 - 如果快速切换搜索词，旧的请求可能覆盖新的结果
export class DataFetcher<T> {
  private result: FetchResult<T> = {
    data: null,
    loading: false,
    error: null,
  };

  async fetch(url: string): Promise<T> {
    this.result.loading = true;
    this.result.error = null;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }
      const data = await response.json();
      // Bug: 没有检查这个请求是否仍然是最新的
      this.result.data = data;
      this.result.loading = false;
      return data;
    } catch (error) {
      this.result.error = error instanceof Error ? error.message : 'Unknown error';
      this.result.loading = false;
      throw error;
    }
  }

  getResult(): FetchResult<T> {
    return this.result;
  }
}

// 搜索组件 - 展示竞态条件问题
export class SearchComponent {
  private fetcher = new DataFetcher<string[]>();
  private results: string[] = [];

  // Bug: 快速输入时，旧的搜索结果可能覆盖新的
  async search(query: string): Promise<void> {
    if (!query) {
      this.results = [];
      return;
    }

    try {
      const data = await this.fetcher.fetch(`/api/search?q=${encodeURIComponent(query)}`);
      // 这里没有检查 query 是否仍然是当前的搜索词
      this.results = data;
    } catch {
      // ignore
    }
  }

  getResults(): string[] {
    return this.results;
  }
}
