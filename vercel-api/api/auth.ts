// ============================================================================
// Auth API - 301 Redirect to /api/v1/auth
// @deprecated 此端点已迁移到 /api/v1/auth
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const queryString = req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const newUrl = `/api/v1/auth${queryString}`;
  res.redirect(301, newUrl);
}
