// ============================================================================
// Publish Release - CI/CD 调用，发布新版本
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../../lib/db';

interface PublishRequest {
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  downloadUrl: string;
  releaseNotes?: string;
  fileSize?: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 验证 CI/CD Token
  const authHeader = req.headers.authorization;
  const ciToken = process.env.CI_PUBLISH_TOKEN;

  if (!ciToken) {
    return res.status(500).json({ error: 'CI_PUBLISH_TOKEN not configured' });
  }

  if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== ciToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body as PublishRequest;

  if (!body.version || !body.platform || !body.downloadUrl) {
    return res.status(400).json({
      error: 'Missing required fields: version, platform, downloadUrl',
    });
  }

  try {
    const sql = getDb();

    // 将该平台的其他版本设为非最新
    await sql`
      UPDATE code_agent.releases
      SET is_latest = false
      WHERE platform = ${body.platform}
    `;

    // 插入新版本
    const result = await sql`
      INSERT INTO code_agent.releases (version, platform, download_url, release_notes, file_size, is_latest)
      VALUES (
        ${body.version},
        ${body.platform},
        ${body.downloadUrl},
        ${body.releaseNotes || null},
        ${body.fileSize || null},
        true
      )
      RETURNING *
    `;

    return res.status(200).json({
      success: true,
      release: result[0],
    });
  } catch (error: any) {
    console.error('Publish error:', error);
    return res.status(500).json({
      error: 'Failed to publish release',
      message: error.message,
    });
  }
}
