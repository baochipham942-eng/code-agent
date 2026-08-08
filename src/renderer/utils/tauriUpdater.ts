/**
 * Tauri-native update service.
 *
 * 历史上这里调用 app 自定义命令（check_for_update / install_update / ...），
 * 但本 app 的渲染器是从 remote origin（http://localhost:8180，本地 webServer）加载的。
 * `src-tauri/permissions/app-commands.toml` 出现之后，app 自定义命令可以按 ACL
 * 白名单授权给 remote origin（`allow-renderer-commands`），所以 `shutdown_web_server_for_update`
 * 这类 app 命令是可以被本文件调用的；而 tauri-updater 官方插件的 check/download/install
 * 命令本身走插件自己的权限体系（`updater:allow-*`），不受这条 ACL 影响，两者并存使用。
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
 * 下载并安装更新（download → 优雅停 webServer → install → relaunch）。
 * onProgress 回调用于在 UI 上展示下载进度；安装完成后调用 relaunch() 自动重启，无需用户手动退出。
 *
 * 为什么 download 和 install 分两步调、中间插一次 invoke（而不是一次
 * `downloadAndInstall`）：Windows 上 tauri-plugin-updater 的 install 在 crate 内部
 * ShellExecuteW 拉起 NSIS 安装程序之后直接 `std::process::exit(0)`
 * （tauri-plugin-updater-2.10.1 updater.rs:865），控制流永不返回——`relaunch()` 执行
 * 不到，Tauri 的 `RunEvent::Exit` 也不会来，我们 spawn 的 webServer 子进程就被
 * Windows 硬杀（TerminateProcess），来不及 flush/checkpoint，留下陈旧 -wal/-shm
 * （2026-08-07 Windows 真机实测坐实）。插件的 JS 路径也没有入口覆盖它的
 * `on_before_exit` 钩子，只能由渲染器在 install 之前显式调 Rust 命令
 * `shutdown_web_server_for_update` 优雅停机。顺序不能换：
 *   - 必须在 download 之后——下载期间渲染器还要靠 webServer 服务，提前停会打瘫页面；
 *   - 必须在 install 之前——Windows 上 install() 之后没有任何我们的代码会再执行。
 */
export async function tauriInstallUpdate(
  onProgress?: (progress: UpdateInstallProgress) => void,
): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  // 必须在 download 之前预加载 relaunch：install 会替换整个 app bundle（含 webServer
  // 正在服务的 renderer chunk，hash 会变），之后再动态 import 会因旧 chunk 404 报
  // "Importing a module script failed"。提前把模块取到内存即可规避。
  const { relaunch } = await import('@tauri-apps/plugin-process');
  const { invoke } = await import('@tauri-apps/api/core');
  const update = await check();
  if (!update) {
    throw new Error('No update available to install');
  }

  let downloaded = 0;
  let total: number | undefined;
  await update.download((event) => {
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

  // 字节已落盘，现在优雅停 webServer（幂等：即便 mac/Linux 后面走 RunEvent::Exit
  // 再收尾一次也是 no-op）。宽限期内没退才由 Rust 侧 SIGKILL 兜底。
  await invoke('shutdown_web_server_for_update');

  try {
    // Windows：此调用不返回（crate 内部 std::process::exit(0)）。
    await update.install();
  } catch (installError) {
    // mac/Linux 才可能走到这里（如签名校验失败）：webServer 已经停了，"僵尸自愈"
    // （recreate_main_window）只在主窗口被销毁重建时触发，覆盖不了这个场景，所以
    // 显式 relaunch() 把 app 重启回当前版本，让 Rust 侧 setup() 重新拉起 webServer。
    console.error('[updater] install failed, relaunching to recover webServer:', installError);
    await relaunch();
    return;
  }

  // mac/Linux 才会走到这里；Windows 上进程已经在 install() 内部退出了。
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
