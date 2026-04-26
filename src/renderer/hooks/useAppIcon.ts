// macOS app icon hook：调 Tauri 命令 desktop_get_app_icon 拿真 app logo（NSWorkspace），
// session 内 memory cache 避免重复 IPC。Tauri 不可用 / 非 macOS / app 找不到时返回 null，
// 调用方 fallback 到 emoji 或 Lucide 图标。

import { useEffect, useState } from 'react';
import { getMacOSAppIcon, isNativeDesktopAvailable } from '../services/nativeDesktop';

type CacheEntry = { dataUrl: string | null; ts: number };
const memCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();

async function fetchAndCache(query: string, size: number): Promise<string | null> {
  const key = `${query}@${size}`;
  if (memCache.has(key)) return memCache.get(key)!.dataUrl;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const result = await getMacOSAppIcon(query, size);
      memCache.set(key, { dataUrl: result.dataUrl, ts: Date.now() });
      return result.dataUrl;
    } catch {
      // app 找不到 / Tauri 不可用 — 缓存 null 避免重复尝试
      memCache.set(key, { dataUrl: null, ts: Date.now() });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

/**
 * 给定 bundle id 或 app 显示名，异步拿 macOS NSWorkspace 提取的真 app 图标 dataURL。
 * 返回 null 表示不可用（Tauri 不可用 / app 找不到 / 非 macOS），调用方应 fallback。
 */
export function useAppIcon(query: string | undefined | null, size = 32): string | null {
  const [icon, setIcon] = useState<string | null>(() => {
    if (!query) return null;
    const key = `${query}@${size}`;
    return memCache.get(key)?.dataUrl ?? null;
  });

  useEffect(() => {
    if (!query) {
      setIcon(null);
      return;
    }
    if (!isNativeDesktopAvailable()) {
      setIcon(null);
      return;
    }
    const key = `${query}@${size}`;
    const cached = memCache.get(key);
    if (cached) {
      setIcon(cached.dataUrl);
      return;
    }
    let cancelled = false;
    fetchAndCache(query, size).then((url) => {
      if (!cancelled) setIcon(url);
    });
    return () => {
      cancelled = true;
    };
  }, [query, size]);

  return icon;
}
