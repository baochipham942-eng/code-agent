// ============================================================================
// Crypto Utils - 客户端加密工具
// 用于加密敏感任务数据（如 prompt、结果）在云端传输和存储
// ============================================================================

import crypto from 'crypto';
import type { EncryptedPayload } from '../../shared/types/cloud';

// 加密算法配置
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节
const TAG_LENGTH = 16; // 认证标签长度
const KEY_LENGTH = 32; // 256 位密钥

/**
 * 加密密钥管理器
 */
class EncryptionKeyManager {
  private keys: Map<string, Buffer> = new Map();
  private activeKeyId: string | null = null;

  /**
   * 生成新的加密密钥
   */
  generateKey(): { keyId: string; key: Buffer } {
    const keyId = `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const key = crypto.randomBytes(KEY_LENGTH);
    this.keys.set(keyId, key);
    this.activeKeyId = keyId;
    return { keyId, key };
  }

  /**
   * 从密码派生密钥（用于用户密码加密）
   */
  deriveKeyFromPassword(password: string, salt: Buffer): { keyId: string; key: Buffer } {
    const key = crypto.pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha256');
    const keyId = `derived_${crypto.createHash('sha256').update(salt).digest('hex').slice(0, 8)}`;
    this.keys.set(keyId, key);
    return { keyId, key };
  }

  /**
   * 获取密钥
   */
  getKey(keyId: string): Buffer | undefined {
    return this.keys.get(keyId);
  }

  /**
   * 获取当前活跃密钥
   */
  getActiveKey(): { keyId: string; key: Buffer } | null {
    if (!this.activeKeyId) {
      return this.generateKey();
    }
    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      return this.generateKey();
    }
    return { keyId: this.activeKeyId, key };
  }

  /**
   * 设置密钥（从存储恢复时使用）
   */
  setKey(keyId: string, key: Buffer): void {
    this.keys.set(keyId, key);
    this.activeKeyId = keyId;
  }

  /**
   * 导出密钥（用于安全存储）
   */
  exportKey(keyId: string): string | null {
    const key = this.keys.get(keyId);
    if (!key) return null;
    return key.toString('base64');
  }

  /**
   * 导入密钥
   */
  importKey(keyId: string, base64Key: string): void {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new Error('Invalid key length');
    }
    this.keys.set(keyId, key);
  }

  /**
   * 清除所有密钥
   */
  clear(): void {
    this.keys.clear();
    this.activeKeyId = null;
  }
}

// 全局密钥管理器实例
const keyManager = new EncryptionKeyManager();

/**
 * 加密数据
 * @param plaintext 明文数据
 * @param keyId 可选的密钥 ID，不提供则使用活跃密钥
 * @returns 加密后的数据包
 */
export function encrypt(plaintext: string, keyId?: string): EncryptedPayload & { keyId: string } {
  // 获取密钥
  let key: Buffer;
  let usedKeyId: string;

  if (keyId) {
    const k = keyManager.getKey(keyId);
    if (!k) throw new Error(`Key not found: ${keyId}`);
    key = k;
    usedKeyId = keyId;
  } else {
    const activeKey = keyManager.getActiveKey();
    if (!activeKey) throw new Error('No active encryption key');
    key = activeKey.key;
    usedKeyId = activeKey.keyId;
  }

  // 生成随机 IV
  const iv = crypto.randomBytes(IV_LENGTH);

  // 创建加密器
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  // 加密数据
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // 获取认证标签
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: tag.toString('base64'),
    algorithm: ALGORITHM,
    keyId: usedKeyId,
  };
}

/**
 * 解密数据
 * @param payload 加密数据包
 * @param keyId 密钥 ID
 * @returns 解密后的明文
 */
export function decrypt(payload: EncryptedPayload, keyId: string): string {
  // 获取密钥
  const key = keyManager.getKey(keyId);
  if (!key) throw new Error(`Key not found: ${keyId}`);

  // 解码 base64
  const iv = Buffer.from(payload.iv, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  // 创建解密器
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  // 设置认证标签
  decipher.setAuthTag(tag);

  // 解密数据
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * 安全地加密敏感数据用于云端存储
 */
export function encryptForCloud(data: string): { encrypted: EncryptedPayload; keyId: string } {
  const result = encrypt(data);
  return {
    encrypted: {
      iv: result.iv,
      data: result.data,
      tag: result.tag,
      algorithm: result.algorithm,
    },
    keyId: result.keyId,
  };
}

/**
 * 解密从云端获取的数据
 */
export function decryptFromCloud(payload: EncryptedPayload, keyId: string): string {
  return decrypt(payload, keyId);
}

/**
 * 生成安全的随机字符串
 */
export function generateSecureRandom(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * 计算数据的 SHA256 哈希
 */
export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 生成 HMAC 签名
 */
export function hmacSign(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * 验证 HMAC 签名
 */
export function hmacVerify(data: string, signature: string, secret: string): boolean {
  const expected = hmacSign(data, secret);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ============================================================================
// 导出密钥管理器方法
// ============================================================================

export const KeyManager = {
  /**
   * 生成新密钥
   */
  generate: () => keyManager.generateKey(),

  /**
   * 从密码派生密钥
   */
  deriveFromPassword: (password: string, salt?: Buffer) => {
    const s = salt || crypto.randomBytes(16);
    return {
      ...keyManager.deriveKeyFromPassword(password, s),
      salt: s.toString('base64'),
    };
  },

  /**
   * 获取当前活跃密钥 ID
   */
  getActiveKeyId: () => keyManager.getActiveKey()?.keyId || null,

  /**
   * 导出密钥（用于安全存储到 keychain）
   */
  export: (keyId: string) => keyManager.exportKey(keyId),

  /**
   * 导入密钥
   */
  import: (keyId: string, base64Key: string) => keyManager.importKey(keyId, base64Key),

  /**
   * 设置密钥
   */
  set: (keyId: string, key: Buffer) => keyManager.setKey(keyId, key),

  /**
   * 清除所有密钥
   */
  clear: () => keyManager.clear(),
};

// ============================================================================
// 用于云端传输的安全信封
// ============================================================================

export interface SecureEnvelope {
  version: number;
  keyId: string;
  payload: EncryptedPayload;
  signature: string;
  timestamp: number;
}

/**
 * 创建安全信封（用于云端传输）
 */
export function createSecureEnvelope(data: string, signingSecret: string): SecureEnvelope {
  const { encrypted, keyId } = encryptForCloud(data);
  const timestamp = Date.now();

  // 创建签名数据
  const signatureData = JSON.stringify({
    keyId,
    payload: encrypted,
    timestamp,
  });

  const signature = hmacSign(signatureData, signingSecret);

  return {
    version: 1,
    keyId,
    payload: encrypted,
    signature,
    timestamp,
  };
}

/**
 * 验证并解开安全信封
 */
export function openSecureEnvelope(
  envelope: SecureEnvelope,
  signingSecret: string,
  maxAgeMs: number = 5 * 60 * 1000 // 默认 5 分钟有效期
): string {
  // 检查版本
  if (envelope.version !== 1) {
    throw new Error('Unsupported envelope version');
  }

  // 检查时间戳
  const age = Date.now() - envelope.timestamp;
  if (age > maxAgeMs) {
    throw new Error('Envelope expired');
  }

  // 验证签名
  const signatureData = JSON.stringify({
    keyId: envelope.keyId,
    payload: envelope.payload,
    timestamp: envelope.timestamp,
  });

  if (!hmacVerify(signatureData, envelope.signature, signingSecret)) {
    throw new Error('Invalid envelope signature');
  }

  // 解密数据
  return decryptFromCloud(envelope.payload, envelope.keyId);
}
