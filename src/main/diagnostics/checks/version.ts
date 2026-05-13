// ============================================================================
// Doctor Check - App 版本
// 查询 updateService 的 checkForUpdates：
//   - hasUpdate=false  → pass
//   - hasUpdate=true   → warn（提示有新版可更新；fail 太重）
//   - 网络/服务未初始化 → warn / skip（不应阻塞 doctor）
// ============================================================================

import {
  getUpdateService,
  isUpdateServiceInitialized,
} from '../../services/cloud/updateService';
import type { DoctorItem } from '../types';

export async function checkAppVersion(): Promise<DoctorItem> {
  if (!isUpdateServiceInitialized()) {
    return {
      category: 'version',
      name: '应用版本',
      status: 'skip',
      message: 'UpdateService 未初始化（CLI 模式）',
    };
  }

  const svc = getUpdateService();
  const currentVersion = svc.getCurrentVersion();

  try {
    const info = await svc.checkForUpdates();
    if (info.hasUpdate) {
      return {
        category: 'version',
        name: '应用版本',
        status: 'warn',
        message: `有新版可更新：${currentVersion} → ${info.latestVersion ?? '?'}`,
        suggestion: '在设置面板点"检查更新"或直接下载新版',
        details: info.releaseNotes,
      };
    }
    return {
      category: 'version',
      name: '应用版本',
      status: 'pass',
      message: `已是最新版本 v${currentVersion}`,
    };
  } catch (err) {
    return {
      category: 'version',
      name: '应用版本',
      status: 'warn',
      message: `更新检查失败：${err instanceof Error ? err.message : String(err)}`,
      suggestion: '可能是网络问题，可忽略；当前版本 v' + currentVersion,
    };
  }
}
