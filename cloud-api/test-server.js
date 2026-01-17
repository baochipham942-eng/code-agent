#!/usr/bin/env node
// ============================================================================
// 本地测试服务器 - 用于测试更新功能
// 运行: node test-server.js
// ============================================================================

const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3456;

// 当前最新版本配置
const LATEST_RELEASE = {
  version: '0.2.0',
  publishedAt: '2025-01-17T16:30:00.000Z',
  releaseNotes: `
## Code Agent v0.2.0

### 新功能
- 支持 8 代 AI Agent 能力演进展示 (Gen1-Gen8)
- 添加缓存管理设置页面，可查看缓存统计和清理缓存
- 添加版本检查与自动更新功能
- 优化代际选择器 UI 宽度，完整显示工具列表

### 修复
- 修复代际下拉菜单内容显示不全的问题
- 改进更新检查的错误处理

### 改进
- 使用 GitHub Releases API + 云端 API 双重更新检查
- 支持下载进度显示和安装
  `.trim(),
  downloads: {
    darwin: {
      url: 'file://' + path.join(__dirname, '..', 'release', 'Code Agent-0.2.0-arm64.dmg'),
      size: 150 * 1024 * 1024,
    },
  },
};

function compareVersions(v1, v2) {
  const normalize = (v) => v.replace(/^v/, '');
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

const server = http.createServer((req, res) => {
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const action = url.searchParams.get('action');
  const version = url.searchParams.get('version') || '0.0.0';
  const platform = url.searchParams.get('platform') || 'darwin';

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (!url.pathname.startsWith('/api/update')) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // 健康检查
  if (action === 'health' || !action) {
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      service: 'Code Agent Update API (Local Test)',
      version: '1.0.0',
      latestAppVersion: LATEST_RELEASE.version,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // 获取最新版本
  if (action === 'latest') {
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      version: LATEST_RELEASE.version,
      publishedAt: LATEST_RELEASE.publishedAt,
      releaseNotes: LATEST_RELEASE.releaseNotes,
      downloads: LATEST_RELEASE.downloads,
    }));
    return;
  }

  // 检查更新
  if (action === 'check') {
    const hasUpdate = compareVersions(LATEST_RELEASE.version, version) > 0;
    const downloadInfo = LATEST_RELEASE.downloads[platform];

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      hasUpdate,
      currentVersion: version,
      latestVersion: LATEST_RELEASE.version,
      publishedAt: LATEST_RELEASE.publishedAt,
      releaseNotes: hasUpdate ? LATEST_RELEASE.releaseNotes : undefined,
      downloadUrl: hasUpdate && downloadInfo ? downloadInfo.url : undefined,
      fileSize: hasUpdate && downloadInfo ? downloadInfo.size : undefined,
    }));
    return;
  }

  res.writeHead(400);
  res.end(JSON.stringify({
    success: false,
    error: 'Unknown action',
    availableActions: ['check', 'latest', 'health'],
  }));
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║        Code Agent Update API - Local Test Server           ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                  ║
║                                                            ║
║  Endpoints:                                                ║
║    GET /api/update                    - Health check       ║
║    GET /api/update?action=check       - Check for updates  ║
║    GET /api/update?action=latest      - Get latest version ║
║                                                            ║
║  Test with:                                                ║
║    curl "http://localhost:${PORT}/api/update?action=check&version=1.0.0"
║                                                            ║
║  Latest version: ${LATEST_RELEASE.version}                              ║
╚════════════════════════════════════════════════════════════╝
`);
});
