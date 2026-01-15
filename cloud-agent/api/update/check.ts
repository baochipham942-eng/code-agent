// ============================================================================
// Update Check - 检查客户端是否有新版本
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, type Release } from '../../lib/db';

interface CheckUpdateRequest {
  currentVersion: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch?: string;
}

interface CheckUpdateResponse {
  hasUpdate: boolean;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
}

// 版本比较函数
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 支持 GET（查询参数）和 POST（body）
  let params: CheckUpdateRequest;

  if (req.method === 'GET') {
    params = {
      currentVersion: req.query.version as string,
      platform: req.query.platform as 'darwin' | 'win32' | 'linux',
      arch: req.query.arch as string,
    };
  } else if (req.method === 'POST') {
    params = req.body as CheckUpdateRequest;
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!params.currentVersion || !params.platform) {
    return res.status(400).json({
      error: 'Missing required parameters: version, platform',
    });
  }

  try {
    const sql = getDb();

    // 获取该平台的最新版本
    const releases = await sql`
      SELECT * FROM code_agent.releases
      WHERE platform = ${params.platform} AND is_latest = true
      LIMIT 1
    `;

    if (releases.length === 0) {
      return res.status(200).json({
        hasUpdate: false,
      } as CheckUpdateResponse);
    }

    const latest = releases[0] as Release;
    const hasUpdate = compareVersions(latest.version, params.currentVersion) > 0;

    const response: CheckUpdateResponse = {
      hasUpdate,
    };

    if (hasUpdate) {
      response.latestVersion = latest.version;
      response.downloadUrl = latest.download_url;
      response.releaseNotes = latest.release_notes || undefined;
      response.fileSize = latest.file_size || undefined;
      response.publishedAt = latest.published_at.toISOString();
    }

    return res.status(200).json(response);
  } catch (error: any) {
    console.error('Update check error:', error);
    return res.status(500).json({
      error: 'Failed to check for updates',
      message: error.message,
    });
  }
}
