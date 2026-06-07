/**
 * Tauri-native update service.
 *
 * 历史上这里调用 app 自定义命令（check_for_update / install_update / ...），
 * 但本 app 的渲染器是从 remote origin（http://localhost:8180，本地 webServer）加载的，
 * Tauri 2 的 ACL 不会把 app 自定义命令授权给 remote origin，导致
 * `invoke('check_for_update')` 被 "not allowed by ACL" 直接拒绝、检查更新永远失败。
 *
 * 修复：改用 tauri-updater 官方插件的 JS API。capability 已显式授权 `updater:*`
 * 给 localhost:8180，插件命令（plugin:updater|check / download-and-install）不受该限制，
 * 既能恢复检查，又保留原生一键下载安装。
 */

import type { UpdateInfo } from '@shared/contract';

const BUILD_APP_VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

/**
 * 读取当前 app 版本（不做网络检查）。
 * 用 core app API；失败时回退到构建期注入的版本号。
 */
export async function tauriGetCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const version = await getVersion();
    if (version) return version;
  } catch {
    // ignore，落到下面的构建期版本
  }
  return BUILD_APP_VERSION ?? '';
}

/**
 * 通过 tauri-updater 插件检查更新（命中 tauri.conf.json 配置的 OSS endpoint + pubkey）。
 * 返回与现有 UI 兼容的 UpdateInfo。
 */
export async function tauriCheckForUpdate(): Promise<UpdateInfo> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  const currentVersion = update?.currentVersion ?? BUILD_APP_VERSION ?? '';
  if (!update) {
    return { hasUpdate: false, currentVersion };
  }
  return {
    hasUpdate: true,
    currentVersion,
    latestVersion: update.version,
    releaseNotes: update.body ?? undefined,
    publishedAt: update.date ?? undefined,
  };
}

/** 安装进度回调：phase=download 时带 downloaded/total 字节，install/relaunch 为后续阶段 */
export interface UpdateInstallProgress {
  phase: 'download' | 'install' | 'relaunch';
  downloaded: number;
  /** 总字节数，部分服务端不返回 contentLength 时为 undefined */
  total?: number;
}

/**
 * 下载并安装更新（插件原生流程：拉取签名包 → 校验 pubkey → 安装 → 自动重启进新版本）。
 * onProgress 回调用于在 UI 上展示下载进度；安装完成后调用 relaunch() 自动重启，无需用户手动退出。
 */
export async function tauriInstallUpdate(
  onProgress?: (progress: UpdateInstallProgress) => void,
): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  // 必须在 downloadAndInstall 之前预加载 relaunch：downloadAndInstall 会替换整个 app bundle
  // （含 webServer 正在服务的 renderer chunk，hash 会变），之后再动态 import 会因旧 chunk 404
  // 报 "Importing a module script failed"。提前把模块取到内存即可规避。
  const { relaunch } = await import('@tauri-apps/plugin-process');
  const update = await check();
  if (!update) {
    throw new Error('No update available to install');
  }

  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength;
        downloaded = 0;
        onProgress?.({ phase: 'download', downloaded, total });
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress?.({ phase: 'download', downloaded, total });
        break;
      case 'Finished':
        onProgress?.({ phase: 'install', downloaded: total ?? downloaded, total });
        break;
    }
  });

  // 安装完成 → 自动重启进新版本（relaunch 已在前面预加载，避免 bundle 替换后再 import 失败）
  onProgress?.({ phase: 'relaunch', downloaded: total ?? downloaded, total });
  await relaunch();
}

/**
 * 用系统默认应用打开手动下载链接（opener 插件，capability 已授权 opener:allow-open-url）。
 */
export async function tauriOpenUpdateUrl(downloadUrl: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(downloadUrl);
}
