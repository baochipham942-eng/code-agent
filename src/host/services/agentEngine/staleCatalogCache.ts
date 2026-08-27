interface StaleCatalogCacheOptions<T> {
  now: () => number;
  load: () => Promise<T>;
  expiresAt: (value: T, loadedAt: number) => number;
  canServeStale: (value: T, now: number) => boolean;
  onBackgroundError: (error: unknown) => void;
}

/** Generation-safe single-flight cache with stale-while-revalidate reads. */
export class StaleCatalogCache<T> {
  private entry: { value: T; expiresAt: number } | null = null;
  private generation = 0;
  private refresh: { generation: number; promise: Promise<void> } | null = null;

  invalidate(): void {
    this.entry = null;
    this.generation += 1;
  }

  async read(options: StaleCatalogCacheOptions<T>): Promise<T> {
    const now = options.now();
    if (this.entry && this.entry.expiresAt > now) return this.entry.value;

    const generation = this.generation;
    const staleValue = this.entry && options.canServeStale(this.entry.value, now)
      ? this.entry.value
      : null;
    const refreshPromise = this.startRefresh(generation, options);
    if (staleValue) {
      void refreshPromise.catch(options.onBackgroundError);
      return staleValue;
    }

    await refreshPromise;
    if (!this.entry || generation !== this.generation) return this.read(options);
    return this.entry.value;
  }

  private startRefresh(
    generation: number,
    options: StaleCatalogCacheOptions<T>,
  ): Promise<void> {
    if (this.refresh?.generation === generation) return this.refresh.promise;
    const refresh = { generation, promise: Promise.resolve() };
    refresh.promise = this.load(generation, options).finally(() => {
      if (this.refresh === refresh) this.refresh = null;
    });
    this.refresh = refresh;
    return refresh.promise;
  }

  private async load(
    generation: number,
    options: StaleCatalogCacheOptions<T>,
  ): Promise<void> {
    const value = await options.load();
    const loadedAt = options.now();
    if (generation !== this.generation) return;
    this.entry = { value, expiresAt: options.expiresAt(value, loadedAt) };
  }
}
