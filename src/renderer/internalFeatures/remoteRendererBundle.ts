interface RemoteRendererBundleOptions<T> {
  cacheKey: string;
  cssUrl: string;
  dataAttribute: 'data-internal-feature' | 'data-plugin-ui';
  entryUrl: string;
  globalName: string;
  ownerId: string;
  readModule: (value: unknown) => T;
}

interface BundleRecord<T> {
  cleanup: () => void;
  promise: Promise<T>;
  references: number;
}

interface RemoteRendererBundleLease<T> {
  dispose: () => void;
  promise: Promise<T>;
}

const bundleCache = new Map<string, BundleRecord<unknown>>();

function clearRemoteGlobal(globalScope: Record<string, unknown>, globalName: string): void {
  try {
    if (delete globalScope[globalName]) return;
  } catch {
    // Bundles emitted with a top-level `var` create a non-configurable browser global.
  }
  try {
    globalScope[globalName] = undefined;
  } catch {
    // Browser-owned read-only globals still must not break host teardown.
  }
}

function createBundleRecord<T>(options: RemoteRendererBundleOptions<T>): BundleRecord<T> {
  const globalScope = window as unknown as Record<string, unknown>;
  clearRemoteGlobal(globalScope, options.globalName);

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = options.cssUrl;
  stylesheet.setAttribute(options.dataAttribute, options.ownerId);
  document.head.appendChild(stylesheet);

  const script = document.createElement('script');
  script.src = options.entryUrl;
  script.async = true;
  script.setAttribute(options.dataAttribute, options.ownerId);

  let settled = false;
  let rejectPending: ((error: Error) => void) | undefined;
  const cleanup = () => {
    stylesheet.remove();
    script.remove();
    clearRemoteGlobal(globalScope, options.globalName);
    if (!settled) {
      settled = true;
      rejectPending?.(new Error('插件界面装载已取消'));
    }
  };
  const promise = new Promise<T>((resolve, reject) => {
    rejectPending = reject;
    script.onload = () => {
      try {
        const loaded = options.readModule(globalScope[options.globalName]);
        settled = true;
        resolve(loaded);
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    script.onerror = () => {
      settled = true;
      reject(new Error('插件界面文件加载失败'));
    };
  }).catch((error) => {
    cleanup();
    bundleCache.delete(options.cacheKey);
    throw error;
  });

  document.head.appendChild(script);
  return { cleanup, promise, references: 0 };
}

export function acquireRemoteRendererBundle<T>(
  options: RemoteRendererBundleOptions<T>,
): RemoteRendererBundleLease<T> {
  let record = bundleCache.get(options.cacheKey) as BundleRecord<T> | undefined;
  if (!record) {
    record = createBundleRecord(options);
    bundleCache.set(options.cacheKey, record as BundleRecord<unknown>);
  }
  record.references += 1;
  let disposed = false;
  return {
    promise: record.promise,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      record.references -= 1;
      if (record.references > 0) return;
      record.cleanup();
      if (bundleCache.get(options.cacheKey) === record) bundleCache.delete(options.cacheKey);
    },
  };
}
