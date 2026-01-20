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
  /** 是否强制更新 - 用户必须更新才能继续使用 */
  forceUpdate: boolean;
  /** 强制更新的最低版本 - 低于此版本的用户必须更新 */
  minRequiredVersion?: string;
  downloads: {
    darwin: { url: string; size: number };
    win32?: { url: string; size: number };
    linux?: { url: string; size: number };
  };
}

// 当前最新版本 - 每次发布新版本时更新这里
// forceUpdate: true  - 强制更新，弹出不可关闭的弹窗
// forceUpdate: false - 可选更新，仅在设置中提示
const LATEST_RELEASE: ReleaseInfo = {
  version: '0.8.6',
  publishedAt: '2026-01-20T09:00:00.000Z',
  releaseNotes: `
## Code Agent v0.8.6

### 文档和测试完善
- 为 7 个核心类添加完整 JSDoc 文档
- 创建 OpenAPI 规范文档 (vercel-api/openapi.yaml)
- TypeDoc 配置扩展，支持 19 个 entry points
- 307 个单元测试全部通过

### 架构文档
- 新增 IPC 通道文档、插件系统文档、热更新文档
- 更新工具系统文档，覆盖 Gen1-Gen8 所有工具

### 修复
- 修复所有代际测试的导入路径问题
- 添加 isolated-vm mock 解决 Node 版本兼容问题
  `.trim(),
  forceUpdate: false,
  downloads: {
    darwin: {
      url: 'https://github.com/anthropics/code-agent/releases/download/v0.8.6/Code.Agent-0.8.6-arm64.dmg',
      size: 160000000,
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
