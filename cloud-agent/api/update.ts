// ============================================================================
// Update API - 统一更新接口
// GET  /api/update?action=check             - 检查更新
// GET  /api/update?action=latest&platform=  - 获取 latest.yml
// POST /api/update?action=publish           - 发布新版本 (CI)
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, type Release } from '../lib/db.js';
import { setCorsHeaders, handleOptions, applyRateLimit, handleError } from '../lib/middleware.js';
import { RATE_LIMITS } from '../lib/rateLimit.js';

// 版本比较
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

// 检查更新
async function handleCheck(req: VercelRequest, res: VercelResponse) {
  const version = (req.query.version || req.body?.currentVersion) as string;
  const platform = (req.query.platform || req.body?.platform) as string;

  if (!version || !platform) {
    return res.status(400).json({ error: 'Missing version or platform' });
  }

  const sql = getDb();
  const releases = await sql`
    SELECT * FROM code_agent.releases
    WHERE platform = ${platform} AND is_latest = true LIMIT 1
  `;

  if (releases.length === 0) {
    return res.status(200).json({ hasUpdate: false });
  }

  const latest = releases[0] as Release;
  const hasUpdate = compareVersions(latest.version, version) > 0;

  return res.status(200).json({
    hasUpdate,
    ...(hasUpdate && {
      latestVersion: latest.version,
      downloadUrl: latest.download_url,
      releaseNotes: latest.release_notes,
      fileSize: latest.file_size,
      publishedAt: latest.published_at,
    }),
  });
}

// 获取 latest.yml (electron-updater 格式)
async function handleLatest(req: VercelRequest, res: VercelResponse) {
  const platform = req.query.platform as string || 'darwin';
  const sql = getDb();

  const releases = await sql`
    SELECT * FROM code_agent.releases
    WHERE platform = ${platform} AND is_latest = true LIMIT 1
  `;

  if (releases.length === 0) {
    return res.status(404).send('No release found');
  }

  const release = releases[0] as Release;
  const yaml = `version: ${release.version}
files:
  - url: ${release.download_url}
    size: ${release.file_size || 0}
path: ${release.download_url.split('/').pop()}
releaseDate: '${new Date(release.published_at).toISOString()}'
`;

  res.setHeader('Content-Type', 'text/yaml');
  return res.status(200).send(yaml);
}

// 发布新版本 (CI 调用)
async function handlePublish(req: VercelRequest, res: VercelResponse) {
  // 验证 CI Token
  const authHeader = req.headers.authorization;
  const ciToken = process.env.CI_PUBLISH_TOKEN;

  if (!ciToken || !authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== ciToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { version, platform, downloadUrl, releaseNotes, fileSize } = req.body;

  if (!version || !platform || !downloadUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sql = getDb();

  // 将该平台其他版本设为非最新
  await sql`UPDATE code_agent.releases SET is_latest = false WHERE platform = ${platform}`;

  // 插入新版本
  const result = await sql`
    INSERT INTO code_agent.releases (version, platform, download_url, release_notes, file_size, is_latest)
    VALUES (${version}, ${platform}, ${downloadUrl}, ${releaseNotes || null}, ${fileSize || null}, true)
    RETURNING *
  `;

  return res.status(200).json({ success: true, release: result[0] });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS - 限制允许的来源
  setCorsHeaders(req, res);
  if (handleOptions(req, res)) return;

  // Rate limiting
  if (applyRateLimit(req, res, undefined, RATE_LIMITS.update)) return;

  const action = req.query.action as string;

  try {
    switch (action) {
      case 'check':
        return handleCheck(req, res);
      case 'latest':
        return handleLatest(req, res);
      case 'publish':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return handlePublish(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action. Use: check, latest, publish' });
    }
  } catch (err) {
    handleError(res, err, 'Update operation failed');
  }
}
