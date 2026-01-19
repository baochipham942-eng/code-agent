// ============================================================================
// Auth API - 统一认证接口
// GET  /api/auth?action=github        - 跳转 GitHub OAuth
// GET  /api/auth?action=callback      - GitHub OAuth 回调
// GET  /api/auth?action=me            - 获取当前用户
// POST /api/auth?action=logout        - 登出
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes, createHash } from 'crypto';
import { getOrCreateUser, generateToken, authenticateRequest, getUserById } from '../lib/auth.js';

// GitHub OAuth 配置
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// State 存储 (生产环境应使用 Redis/Database)
const stateStore = new Map<string, { createdAt: number; redirectUri: string }>();
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 分钟过期

// 使用加密安全的随机数生成 state
function generateState(redirectUri: string): string {
  const state = randomBytes(32).toString('hex');
  stateStore.set(state, { createdAt: Date.now(), redirectUri });
  // 清理过期的 state
  for (const [key, value] of stateStore.entries()) {
    if (Date.now() - value.createdAt > STATE_EXPIRY_MS) {
      stateStore.delete(key);
    }
  }
  return state;
}

// 验证 state
function validateState(state: string | undefined): boolean {
  if (!state || typeof state !== 'string') return false;
  const stored = stateStore.get(state);
  if (!stored) return false;
  if (Date.now() - stored.createdAt > STATE_EXPIRY_MS) {
    stateStore.delete(state);
    return false;
  }
  stateStore.delete(state); // 使用后删除
  return true;
}

// 允许的 CORS 来源
const ALLOWED_ORIGINS = [
  'codeagent://',
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.CLIENT_URL,
].filter(Boolean) as string[];

function setCorsHeaders(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// GitHub OAuth 入口
function handleGitHubLogin(req: VercelRequest, res: VercelResponse) {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).json({ error: 'GitHub OAuth not configured' });
  }

  const redirectUri = process.env.GITHUB_CALLBACK_URL ||
    `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/auth?action=callback`;

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'user:email read:user',
    state: generateState(redirectUri),
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}

// GitHub OAuth 回调
async function handleGitHubCallback(req: VercelRequest, res: VercelResponse) {
  const { code, error, error_description, state } = req.query;

  if (error) {
    return res.redirect(`codeagent://auth/error?message=${encodeURIComponent(error_description as string || error as string)}`);
  }

  // 验证 state 防止 CSRF 攻击
  if (!validateState(state as string)) {
    return res.redirect('codeagent://auth/error?message=Invalid or expired state parameter');
  }

  if (!code || typeof code !== 'string') {
    return res.redirect('codeagent://auth/error?message=Missing authorization code');
  }

  try {
    // 获取 access_token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenResponse.json() as { access_token?: string };
    if (!tokenData.access_token) {
      throw new Error('Failed to get access token');
    }

    // 获取用户信息
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' },
    });
    const githubUser = await userResponse.json() as { id: number; login: string; name: string | null; email: string | null; avatar_url: string };

    // 获取邮箱
    let email = githubUser.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' },
      });
      const emails = await emailsResponse.json() as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find(e => e.primary && e.verified)?.email || emails[0]?.email;
    }

    if (!email) {
      throw new Error('Unable to get email from GitHub');
    }

    // 创建/获取用户并生成 token
    const user = await getOrCreateUser('github', githubUser.id.toString(), email, githubUser.name || githubUser.login, githubUser.avatar_url);
    const token = await generateToken(user);

    res.redirect(`codeagent://auth/success?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify({
      id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url,
    }))}`);
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    res.redirect('codeagent://auth/error?message=Authentication failed');
  }
}

// 获取当前用户
async function handleGetMe(req: VercelRequest, res: VercelResponse) {
  const payload = await authenticateRequest(req.headers.authorization);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await getUserById(payload.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.status(200).json({
    id: user.id, email: user.email, name: user.name,
    avatarUrl: user.avatar_url, provider: user.provider, createdAt: user.created_at,
  });
}

// 登出
function handleLogout(req: VercelRequest, res: VercelResponse) {
  return res.status(200).json({ success: true, message: 'Logged out successfully' });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS - 限制允许的来源
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action as string;

  switch (action) {
    case 'github':
      return handleGitHubLogin(req, res);
    case 'callback':
      return handleGitHubCallback(req, res);
    case 'me':
      return handleGetMe(req, res);
    case 'logout':
      return handleLogout(req, res);
    default:
      return res.status(400).json({ error: 'Invalid action. Use: github, callback, me, logout' });
  }
}
