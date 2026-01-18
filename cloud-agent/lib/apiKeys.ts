// ============================================================================
// API Key Manager - 管理用户和系统 API Key
// ============================================================================

import { getDb, ADMIN_EMAILS, type User } from './db.js';

export type ApiKeyType = 'deepseek' | 'openai' | 'anthropic' | 'perplexity';

// API Key 来源
export type KeySource = 'system' | 'user';

export interface ApiKeyResult {
  key: string;
  source: KeySource;
}

/**
 * 判断用户是否为管理员
 */
export function isAdmin(user: User): boolean {
  return user.role === 'admin' || ADMIN_EMAILS.includes(user.email);
}

/**
 * 获取用户的 API Key
 * - 管理员：优先使用系统 Key，没有则用用户自己的
 * - 普通用户：只能用自己配置的 Key
 */
export async function getApiKey(
  userId: string,
  keyType: ApiKeyType
): Promise<ApiKeyResult | null> {
  const sql = getDb();

  // 获取用户信息
  const users = await sql`
    SELECT * FROM code_agent.users WHERE id = ${userId}
  `;

  if (users.length === 0) {
    return null;
  }

  const user = users[0] as User;
  const userIsAdmin = isAdmin(user);

  // 管理员优先使用系统环境变量中的 Key
  if (userIsAdmin) {
    const systemKey = getSystemApiKey(keyType);
    if (systemKey) {
      return { key: systemKey, source: 'system' };
    }
  }

  // 查询用户自己配置的 Key
  const userKeys = await sql`
    SELECT * FROM code_agent.user_api_keys WHERE user_id = ${userId}
  `;

  if (userKeys.length > 0) {
    const keyColumn = `${keyType}_api_key`;
    const userKey = userKeys[0][keyColumn] as string | null;
    if (userKey) {
      return { key: userKey, source: 'user' };
    }
  }

  return null;
}

/**
 * 从环境变量获取系统 API Key
 */
export function getSystemApiKey(keyType: ApiKeyType): string | null {
  const envMap: Record<ApiKeyType, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };

  return process.env[envMap[keyType]] || null;
}

/**
 * 保存用户的 API Key
 */
export async function saveUserApiKey(
  userId: string,
  keyType: ApiKeyType,
  apiKey: string
): Promise<boolean> {
  const sql = getDb();
  const keyColumn = `${keyType}_api_key`;

  // 使用 upsert 模式
  await sql`
    INSERT INTO code_agent.user_api_keys (user_id, ${sql(keyColumn)})
    VALUES (${userId}, ${apiKey})
    ON CONFLICT (user_id)
    DO UPDATE SET ${sql(keyColumn)} = ${apiKey}, updated_at = NOW()
  `;

  return true;
}

/**
 * 删除用户的 API Key
 */
export async function deleteUserApiKey(
  userId: string,
  keyType: ApiKeyType
): Promise<boolean> {
  const sql = getDb();
  const keyColumn = `${keyType}_api_key`;

  await sql`
    UPDATE code_agent.user_api_keys
    SET ${sql(keyColumn)} = NULL, updated_at = NOW()
    WHERE user_id = ${userId}
  `;

  return true;
}

/**
 * 获取用户所有 Key 的配置状态（不返回实际 Key）
 */
export async function getUserKeyStatus(userId: string): Promise<{
  isAdmin: boolean;
  keys: Record<ApiKeyType, { configured: boolean; source: KeySource | null }>;
}> {
  const sql = getDb();

  // 获取用户信息
  const users = await sql`
    SELECT * FROM code_agent.users WHERE id = ${userId}
  `;

  if (users.length === 0) {
    throw new Error('User not found');
  }

  const user = users[0] as User;
  const userIsAdmin = isAdmin(user);

  // 获取用户配置的 Key
  const userKeys = await sql`
    SELECT * FROM code_agent.user_api_keys WHERE user_id = ${userId}
  `;

  const keyTypes: ApiKeyType[] = ['deepseek', 'openai', 'anthropic', 'perplexity'];
  const result: Record<ApiKeyType, { configured: boolean; source: KeySource | null }> = {
    deepseek: { configured: false, source: null },
    openai: { configured: false, source: null },
    anthropic: { configured: false, source: null },
    perplexity: { configured: false, source: null },
  };

  for (const keyType of keyTypes) {
    // 管理员检查系统 Key
    if (userIsAdmin) {
      const systemKey = getSystemApiKey(keyType);
      if (systemKey) {
        result[keyType] = { configured: true, source: 'system' };
        continue;
      }
    }

    // 检查用户自己的 Key
    if (userKeys.length > 0) {
      const keyColumn = `${keyType}_api_key`;
      const userKey = userKeys[0][keyColumn] as string | null;
      if (userKey) {
        result[keyType] = { configured: true, source: 'user' };
      }
    }
  }

  return { isAdmin: userIsAdmin, keys: result };
}

/**
 * 设置用户角色（仅管理员可操作）
 */
export async function setUserRole(
  adminUserId: string,
  targetUserId: string,
  role: 'admin' | 'user'
): Promise<boolean> {
  const sql = getDb();

  // 验证操作者是否为管理员
  const admins = await sql`
    SELECT * FROM code_agent.users WHERE id = ${adminUserId}
  `;

  if (admins.length === 0 || !isAdmin(admins[0] as User)) {
    throw new Error('Permission denied: only admins can change user roles');
  }

  await sql`
    UPDATE code_agent.users
    SET role = ${role}
    WHERE id = ${targetUserId}
  `;

  return true;
}
