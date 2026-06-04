// ============================================================================
// 前端热更：缓存目录解析 + active 健康校验（读取侧）
// ============================================================================
// serve 路径决策：active 健康（合法 meta + index.html 存在）→ serve 云端版；
// 否则一律 fallback 包内 builtin。写入/原子切换（rename pending→active）在编排层。
// 兜底铁律：meta 缺失/畸形/缺字段、index.html 缺失 → 视为不健康，回包内基线。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function rendererCacheDir(dataDir: string): string {
  return join(dataDir, 'renderer-cache');
}

export function activeBundleDir(dataDir: string): string {
  return join(rendererCacheDir(dataDir), 'active');
}

export function pendingBundleDir(dataDir: string): string {
  return join(rendererCacheDir(dataDir), 'pending');
}

export interface ActiveBundleMeta {
  version: string;
  contentHash: string;
}

function isValidMeta(value: unknown): value is ActiveBundleMeta {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.version === 'string' && m.version.length > 0 &&
    typeof m.contentHash === 'string' && m.contentHash.length > 0
  );
}

export function readActiveBundleMeta(dataDir: string): ActiveBundleMeta | null {
  try {
    const raw = readFileSync(join(activeBundleDir(dataDir), '.bundle-meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return isValidMeta(parsed)
      ? { version: parsed.version, contentHash: parsed.contentHash }
      : null;
  } catch {
    return null;
  }
}

/** 喂给契约门 BundleApplyContext.activeContentHash */
export function readActiveContentHash(dataDir: string): string | null {
  return readActiveBundleMeta(dataDir)?.contentHash ?? null;
}

/** serve 目录决策：active 健康 → active 绝对路径；否则包内 builtin */
export function resolveRendererServeDir(dataDir: string, builtinDir: string): string {
  const active = activeBundleDir(dataDir);
  if (readActiveBundleMeta(dataDir) && existsSync(join(active, 'index.html'))) {
    return active;
  }
  return builtinDir;
}
