// ============================================================================
// Plugin Install Concurrency & Abort Helpers
// ============================================================================
// 同 id 安装互斥 + 取消信号检查 + 可中止目录拷贝（installService 专用）
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { InstallResult } from './types';

const activePluginInstalls = new Map<string, Promise<InstallResult>>();

function normalizeInstallKey(pluginSpec: string): string {
  return pluginSpec.trim().toLowerCase();
}

export function runExclusivePluginInstall(
  pluginSpec: string,
  install: () => Promise<InstallResult>,
): Promise<InstallResult> {
  const key = normalizeInstallKey(pluginSpec);
  if (activePluginInstalls.has(key)) {
    return Promise.reject(new Error(`Plugin '${pluginSpec.trim()}' installation is already in progress`));
  }

  let tracked!: Promise<InstallResult>;
  tracked = install().finally(() => {
    if (activePluginInstalls.get(key) === tracked) {
      activePluginInstalls.delete(key);
    }
  });
  activePluginInstalls.set(key, tracked);
  return tracked;
}

export function throwIfInstallAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function copyDirectory(src: string, dest: string, signal?: AbortSignal): Promise<void> {
  throwIfInstallAborted(signal);
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    throwIfInstallAborted(signal);
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, signal);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      throwIfInstallAborted(signal);
    }
  }
}
