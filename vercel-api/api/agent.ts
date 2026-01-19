// ============================================================================
// Agent API - 301 Redirect to /api/v1/agent
// @deprecated 此端点已迁移到 /api/v1/agent
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const queryString = req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const newUrl = `/api/v1/agent${queryString}`;
  res.redirect(301, newUrl);
}
