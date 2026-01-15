// ============================================================================
// GitHub OAuth Login - 重定向到 GitHub 授权页面
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.GITHUB_CLIENT_ID;

  if (!clientId) {
    return res.status(500).json({ error: 'GitHub OAuth not configured' });
  }

  // 从查询参数获取回调 URL（客户端传入）
  const redirectUri = process.env.GITHUB_CALLBACK_URL ||
    `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/auth/github/callback`;

  // 构建 GitHub OAuth URL
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'user:email read:user',
    state: generateState(),
  });

  const githubAuthUrl = `https://github.com/login/oauth/authorize?${params}`;

  // 重定向到 GitHub
  res.redirect(githubAuthUrl);
}

function generateState(): string {
  return Math.random().toString(36).substring(2, 15);
}
