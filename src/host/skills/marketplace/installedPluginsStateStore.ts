// ============================================================================
// installedPluginsStateStore — 安装状态文件路径 + 内存状态版本 + 串行落盘队列
// （N-SKILL-SCAN-VERSION-RESCAN，ai-review R5/R6 Important 1）
// 内存版本号：每次成功落盘自增；并发写方（enable/disable/install/rescan 合写）
// 都经过同一计数。所有落盘（常规保存与 CAS 保存）排进同一条 promise 链队列——
// 上一笔写完才放下一笔，CAS 的「版本比对 → 落盘」不可能撞上一笔正在进行中的
// 异步写（R6：R5 的 CAS 只校对已完成的版本，进行中的慢写仍能在 CAS 之后覆盖）。
// ============================================================================

import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getUserConfigDir } from '../../config/configPaths';
import type { InstalledPluginsFile } from './types';

const INSTALLED_PLUGINS_FILE = 'installed-plugins.json';

let stateVersion = 0;
let saveQueue: Promise<unknown> = Promise.resolve();

export function getInstalledPluginsFilePath(): string {
  return path.join(getUserConfigDir(), INSTALLED_PLUGINS_FILE);
}

export function getInstalledPluginsStateVersion(): number {
  return stateVersion;
}

/** 所有安装状态落盘排进同一条队列：上一笔完成才放下一笔，单笔失败不堵后续。 */
function enqueueInstalledPluginsSave<T>(task: () => Promise<T>): Promise<T> {
  const run = saveQueue.then(task, task);
  saveQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function writeStateFile(filePath: string, state: InstalledPluginsFile): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fsSync.writeFileSync(tempPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fsSync.renameSync(tempPath, filePath);
  } catch (error) {
    fsSync.rmSync(tempPath, { force: true });
    throw error;
  }
}

/** 常规保存的唯一实现：排队落盘并自增版本（installService.saveInstalledPlugins 委托到这里）。 */
export function saveInstalledPluginsState(state: InstalledPluginsFile): Promise<void> {
  return enqueueInstalledPluginsSave(async () => {
    await writeStateFile(getInstalledPluginsFilePath(), state);
    stateVersion += 1;
  });
}

/**
 * CAS 保存：与常规保存排同一队列；轮到本笔时内存状态版本仍是 expectedVersion
 * 才落盘并自增，否则返回 false。版本比对与落盘之间不可能插入其他保存（队列
 * 串行 + 同步写），调用方负责「读 → 记版本 → 合并 → CAS 保存」的重试循环。
 */
export function saveInstalledPluginsIfVersionUnchanged(
  state: InstalledPluginsFile,
  expectedVersion: number,
): Promise<boolean> {
  return enqueueInstalledPluginsSave(async () => {
    if (stateVersion !== expectedVersion) return false;
    await writeStateFile(getInstalledPluginsFilePath(), state);
    stateVersion += 1;
    return true;
  });
}
