// ============================================================================
// Latest Mac YML - electron-updater 需要的更新清单文件
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, type Release } from '../../lib/db';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = getDb();

    const releases = await sql`
      SELECT * FROM code_agent.releases
      WHERE platform = 'darwin' AND is_latest = true
      LIMIT 1
    `;

    if (releases.length === 0) {
      return res.status(404).send('No release found');
    }

    const release = releases[0] as Release;

    // 生成 electron-updater 格式的 YAML
    const yaml = `version: ${release.version}
files:
  - url: ${release.download_url}
    size: ${release.file_size || 0}
path: ${release.download_url.split('/').pop()}
releaseDate: '${release.published_at.toISOString()}'
`;

    res.setHeader('Content-Type', 'text/yaml');
    return res.status(200).send(yaml);
  } catch (error: any) {
    console.error('Latest YML error:', error);
    return res.status(500).send('Internal server error');
  }
}
