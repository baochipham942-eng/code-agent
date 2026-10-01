// ============================================================================
// installedPluginsStateStore — 安装状态文件路径 + 内存状态版本 + CAS 保存
// （N-SKILL-SCAN-VERSION-RESCAN，ai-review R5 Important 1）
// 内存版本号：saveInstalledPlugins 每次成功落盘后 noteInstalledPluginsStateSaved
// 自增；并发写方（enable/disable/install/rescan 合写）都经过同一计数。CAS 保存
// 用同步写把「版本比对 → 落盘」收进同一个 tick——JS 单线程下这才是真无窗口。
// ============================================================================

import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getUserConfigDir } from '../../config/configPaths';
import type { InstalledPluginsFile } from './types';

const INSTALLED_PLUGINS_FILE = 'installed-plugins.json';

let stateVersion = 0;

export function getInstalledPluginsFilePath(): string {
  return path.join(getUserConfigDir(), INSTALLED_PLUGINS_FILE);
}

export function getInstalledPluginsStateVersion(): number {
  return stateVersion;
}

/** saveInstalledPlugins 成功落盘后调用，自增内存状态版本。 */
export function noteInstalledPluginsStateSaved(): void {
  stateVersion += 1;
}

/**
 * CAS 保存：内存状态版本仍是 expectedVersion 才落盘并自增，否则返回 false。
 * 版本比对与写入在同一个同步区段内完成（fsSync），调用 tick 内不可能插入并发保存；
 * 调用方负责「读 → 记版本 → 合并 → CAS 保存」的重试循环。
 */
export function saveInstalledPluginsIfVersionUnchanged(
  state: InstalledPluginsFile,
  expectedVersion: number,
): boolean {
  if (stateVersion !== expectedVersion) return false;
  const filePath = getInstalledPluginsFilePath();
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fsSync.writeFileSync(tempPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fsSync.renameSync(tempPath, filePath);
  } catch (error) {
    fsSync.rmSync(tempPath, { force: true });
    throw error;
  }
  stateVersion += 1;
  return true;
}
