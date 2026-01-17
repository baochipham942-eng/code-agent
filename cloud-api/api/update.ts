// ============================================================================
// Code Agent Update API - 版本检查与更新下载服务
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ----------------------------------------------------------------------------
// 配置 - 最新版本信息
// ----------------------------------------------------------------------------

interface ReleaseInfo {
  version: string;
  publishedAt: string;
  releaseNotes: string;
  downloads: {
    darwin: { url: string; size: number };
    win32?: { url: string; size: number };
    linux?: { url: string; size: number };
  };
}

// 当前最新版本 - 每次发布新版本时更新这里
const LATEST_RELEASE: ReleaseInfo = {
  version: '0.2.2',
  publishedAt: '2025-01-17T17:30:00.000Z',
  releaseNotes: `
## Code Agent v0.2.2

### 修复
- 修复外层代际显示格式（Gen X vX.0）
- 修复下拉菜单头部"选择代际"样式
- 优化工具标签全部展示并自动换行

### 改进
- 下拉菜单支持显示所有工具（不再省略）
- UI 文案本地化为中文
  `.trim(),
  downloads: {
    darwin: {
      // 实际下载地址需要在打包后更新
      url: 'https://github.com/baochipham942-eng/code-agent/releases/download/v0.2.2/Code-Agent-0.2.2-arm64.dmg',
      size: 130 * 1024 * 1024, // 约 130MB
    },
    // win32 和 linux 暂未提供
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
      downloads: LATEST_RELEASE.downloads,
    });
  }

  // 检查更新
  if (action === 'check') {
    const currentVersion = (version as string) || '0.0.0';
    const clientPlatform = (platform as string) || 'darwin';

    const hasUpdate = compareVersions(LATEST_RELEASE.version, currentVersion) > 0;
    const downloadInfo = LATEST_RELEASE.downloads[clientPlatform as keyof typeof LATEST_RELEASE.downloads];

    return res.status(200).json({
      success: true,
      hasUpdate,
      currentVersion,
      latestVersion: LATEST_RELEASE.version,
      publishedAt: LATEST_RELEASE.publishedAt,
      releaseNotes: hasUpdate ? LATEST_RELEASE.releaseNotes : undefined,
      downloadUrl: hasUpdate && downloadInfo ? downloadInfo.url : undefined,
      fileSize: hasUpdate && downloadInfo ? downloadInfo.size : undefined,
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
