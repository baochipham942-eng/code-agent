// ============================================================================
// GitHub OAuth Callback - 处理 GitHub 授权回调
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getOrCreateUser, generateToken } from '../../../lib/auth';

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { code, error, error_description } = req.query;

  // 处理授权错误
  if (error) {
    return res.redirect(`codeagent://auth/error?message=${encodeURIComponent(error_description as string || error as string)}`);
  }

  if (!code || typeof code !== 'string') {
    return res.redirect('codeagent://auth/error?message=Missing authorization code');
  }

  try {
    // 1. 用 code 换取 access_token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;

    if (!tokenData.access_token) {
      throw new Error('Failed to get access token from GitHub');
    }

    // 2. 获取用户信息
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    const githubUser = (await userResponse.json()) as GitHubUser;

    // 3. 获取用户邮箱（如果主账号没有公开邮箱）
    let email = githubUser.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      const emails = (await emailsResponse.json()) as GitHubEmail[];
      const primaryEmail = emails.find((e) => e.primary && e.verified);
      email = primaryEmail?.email || emails[0]?.email;
    }

    if (!email) {
      throw new Error('Unable to get email from GitHub account');
    }

    // 4. 创建或获取用户
    const user = await getOrCreateUser(
      'github',
      githubUser.id.toString(),
      email,
      githubUser.name || githubUser.login,
      githubUser.avatar_url
    );

    // 5. 生成 JWT Token
    const token = await generateToken(user);

    // 6. 重定向回客户端（使用自定义协议）
    // codeagent:// 协议由 Electron 客户端注册处理
    const redirectUrl = `codeagent://auth/success?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar_url,
    }))}`;

    res.redirect(redirectUrl);
  } catch (error: any) {
    console.error('GitHub OAuth error:', error);
    res.redirect(`codeagent://auth/error?message=${encodeURIComponent(error.message || 'Authentication failed')}`);
  }
}
