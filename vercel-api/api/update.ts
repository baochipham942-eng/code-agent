// ============================================================================
// Code Agent Update API - 版本检查与更新下载服务
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ----------------------------------------------------------------------------
// 配置 - 最新版本信息
// ----------------------------------------------------------------------------

interface DownloadAsset {
  url: string;
  size: number;
  /**
   * SHA-256 hex digest of the artifact at `url`. When set, clients carrying
   * 74f14749+ will refuse to install if the local hash doesn't match. Leave
   * undefined for backward-compat with older clients.
   */
  sha256?: string;
}

interface ReleaseInfo {
  version: string;
  publishedAt: string;
  releaseNotes: string;
  /** 是否强制更新 - 用户必须更新才能继续使用 */
  forceUpdate: boolean;
  /** 强制更新的最低版本 - 低于此版本的用户必须更新 */
  minRequiredVersion?: string;
  downloads: {
    darwin: DownloadAsset;
    win32?: DownloadAsset;
    linux?: DownloadAsset;
  };
}

// 当前最新版本 - 每次发布新版本时更新这里
// forceUpdate: true  - 强制更新，弹出不可关闭的弹窗
// forceUpdate: false - 可选更新，仅在设置中提示
const LATEST_RELEASE: ReleaseInfo = {
  version: '0.16.65',
  publishedAt: '2026-04-28T00:50:00.000Z',
  releaseNotes: `
## Code Agent v0.16.65

### Update path safety
- 客户端下载完毕后会用 cloud 提供的 sha256 本地校验，hash 不一致直接拒绝安装并删除文件（防 MITM / DNS 劫持 / CDN 投毒）。
- Tauri 设置页的"前往下载"按钮收紧，只能打开 HTML 发布页，不能直接打开 .dmg / .exe 等二进制（防绕过签名链）。

### Architecture
- protocol/ 层彻底符合"只放类型和常量"约束：dispatch/ 搬到 tools/dispatch/、events runtime 搬到 services/eventing/。
- OpenChronicle Phase 1–3、_meta envelope、Live Preview V2、Tauri sidecar 修复、browser-computer 隐私加固。
  `.trim(),
  forceUpdate: false, // 可选更新（先观察客户端校验路径稳定性，再考虑 force）
  minRequiredVersion: '0.10.0',
  downloads: {
    darwin: {
      url: 'https://github.com/baochipham942-eng/code-agent/releases/download/v0.16.65/Code-Agent-0.16.65-arm64.dmg',
      size: 147695869, // ~141MB
      sha256: 'fd726aaa27013928c5943576074384379ab8beede5b6b73071e493fa1dfd0cc4',
    },
  },
};

// ----------------------------------------------------------------------------
// 版本比较
// ----------------------------------------------------------------------------

function compareVersions(v1: string, v2: string): number {
  const normalize = (v: string) => v.replace(/^v/, '');
  const parts1 = normalize(v1).split('.').map(Number);
  const parts2 = normalize(v2).split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

// ----------------------------------------------------------------------------
// API Handler
// ----------------------------------------------------------------------------

export default function handler(req: VercelRequest, res: VercelResponse) {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action, version, platform } = req.query;

  // 获取最新版本信息
  if (action === 'latest') {
    return res.status(200).json({
      success: true,
      version: LATEST_RELEASE.version,
      publishedAt: LATEST_RELEASE.publishedAt,
      releaseNotes: LATEST_RELEASE.releaseNotes,
      forceUpdate: LATEST_RELEASE.forceUpdate,
      minRequiredVersion: LATEST_RELEASE.minRequiredVersion,
      downloads: LATEST_RELEASE.downloads,
    });
  }

  // 检查更新
  if (action === 'check') {
    const currentVersion = (version as string) || '0.0.0';
    const clientPlatform = (platform as string) || 'darwin';

    const hasUpdate = compareVersions(LATEST_RELEASE.version, currentVersion) > 0;
    const downloadInfo = LATEST_RELEASE.downloads[clientPlatform as keyof typeof LATEST_RELEASE.downloads];

    // 判断是否需要强制更新
    // 1. 如果 forceUpdate 为 true，且有新版本 -> 强制更新
    // 2. 如果设置了 minRequiredVersion，且当前版本低于最低要求 -> 强制更新
    let isForceUpdate = false;
    if (hasUpdate) {
      if (LATEST_RELEASE.forceUpdate) {
        isForceUpdate = true;
      } else if (LATEST_RELEASE.minRequiredVersion) {
        isForceUpdate = compareVersions(LATEST_RELEASE.minRequiredVersion, currentVersion) > 0;
      }
    }

    return res.status(200).json({
      success: true,
      hasUpdate,
      forceUpdate: isForceUpdate,
      currentVersion,
      latestVersion: LATEST_RELEASE.version,
      publishedAt: LATEST_RELEASE.publishedAt,
      releaseNotes: hasUpdate ? LATEST_RELEASE.releaseNotes : undefined,
      downloadUrl: hasUpdate && downloadInfo ? downloadInfo.url : undefined,
      fileSize: hasUpdate && downloadInfo ? downloadInfo.size : undefined,
      // sha256 of the dmg/exe at downloadUrl. Clients with the M6.a fix
      // (commit 74f14749+) will refuse to install if local hash mismatches.
      sha256: hasUpdate && downloadInfo ? downloadInfo.sha256 : undefined,
    });
  }

  // 健康检查
  if (action === 'health' || !action) {
    return res.status(200).json({
      success: true,
      service: 'Code Agent Update API',
      version: '1.0.0',
      latestAppVersion: LATEST_RELEASE.version,
      timestamp: new Date().toISOString(),
    });
  }

  // 未知操作
  return res.status(400).json({
    success: false,
    error: 'Unknown action',
    availableActions: ['check', 'latest', 'health'],
  });
}
