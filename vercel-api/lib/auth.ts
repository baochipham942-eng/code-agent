// ============================================================================
// Authentication Utilities - JWT Token Management
// ============================================================================

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getDb, ADMIN_EMAILS, type User } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger('AuthLib');

// JWT 密钥 - 必须在生产环境中设置
const authSecret = process.env.AUTH_SECRET;
if (!authSecret && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_SECRET environment variable is required in production');
}
const JWT_SECRET = new TextEncoder().encode(
  authSecret || 'dev-secret-only-for-local-development'
);

const JWT_ISSUER = 'code-agent';
const JWT_AUDIENCE = 'code-agent-client';
const TOKEN_EXPIRY = '7d'; // Token 有效期 7 天

export interface TokenPayload extends JWTPayload {
  userId: string;
  email: string;
  name?: string;
}

// 生成 JWT Token
export async function generateToken(user: User): Promise<string> {
  const token = await new SignJWT({
    userId: user.id,
    email: user.email,
    name: user.name,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(JWT_SECRET);

  return token;
}

// 验证 JWT Token
export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    return payload as TokenPayload;
  } catch (error) {
    logger.error('Token verification failed', error);
    return null;
  }
}

// 扩展的认证结果，包含管理员状态
export interface AuthResult extends TokenPayload {
  isAdmin: boolean;
}

// 从请求头中提取并验证 Token
export async function authenticateRequest(
  authHeader: string | undefined
): Promise<AuthResult | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload) {
    return null;
  }

  // 检查是否为管理员：硬编码列表 OR 数据库中的管理员标记
  let isAdmin = ADMIN_EMAILS.includes(payload.email);

  // 如果不在硬编码列表，查询数据库检查管理员状态
  if (!isAdmin && payload.userId) {
    try {
      const sql = getDb();

      // 检查 code_agent.users 表的 role 字段
      const users = await sql`
        SELECT role FROM code_agent.users WHERE id = ${payload.userId}
      ` as unknown as { role: string }[];

      if (users.length > 0 && users[0].role === 'admin') {
        isAdmin = true;
      }

      // 如果还不是管理员，检查 public.profiles 表的 is_admin 字段（Supabase Auth）
      if (!isAdmin) {
        const profiles = await sql`
          SELECT is_admin FROM public.profiles WHERE id = ${payload.userId}
        ` as unknown as { is_admin: boolean }[];

        if (profiles.length > 0 && profiles[0].is_admin === true) {
          isAdmin = true;
        }
      }
    } catch (error) {
      logger.warn('Failed to check user admin status from database', error);
    }
  }

  return {
    ...payload,
    isAdmin,
  };
}

// 获取或创建用户（OAuth 回调后使用）
export async function getOrCreateUser(
  provider: string,
  providerId: string,
  email: string,
  name?: string,
  avatarUrl?: string
): Promise<User> {
  const sql = getDb();

  // 先查找是否已存在
  const existing = await sql`
    SELECT * FROM code_agent.users
    WHERE provider = ${provider} AND provider_id = ${providerId}
  ` as unknown as User[];

  if (existing.length > 0) {
    // 更新最后登录时间
    await sql`
      UPDATE code_agent.users
      SET last_login_at = NOW(), name = COALESCE(${name}, name), avatar_url = COALESCE(${avatarUrl}, avatar_url)
      WHERE id = ${existing[0].id}
    `;
    return existing[0];
  }

  // 创建新用户，根据邮箱判断是否为管理员
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'user';

  const result = await sql`
    INSERT INTO code_agent.users (email, name, avatar_url, provider, provider_id, role, last_login_at)
    VALUES (${email}, ${name}, ${avatarUrl}, ${provider}, ${providerId}, ${role}, NOW())
    RETURNING *
  ` as unknown as User[];

  return result[0];
}

// 通过 ID 获取用户
export async function getUserById(userId: string): Promise<User | null> {
  const sql = getDb();

  const result = await sql`
    SELECT * FROM code_agent.users WHERE id = ${userId}
  ` as unknown as User[];

  return result.length > 0 ? result[0] : null;
}
