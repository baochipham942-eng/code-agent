// ============================================================================
// Cloud Crypto Utils - 云端解密工具
// 用于在 Edge Function 中解密客户端加密的数据
// ============================================================================

/**
 * 加密数据包格式
 */
export interface EncryptedPayload {
  iv: string; // 初始化向量 (base64)
  data: string; // 加密后的数据 (base64)
  tag: string; // 认证标签 (base64)
  algorithm: 'aes-256-gcm';
}

/**
 * 密钥存储
 * 注意：在生产环境中，密钥应该从安全的密钥管理服务获取
 */
const keyStore = new Map<string, Uint8Array>();

/**
 * Base64 解码
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Uint8Array 转 Base64
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 导入密钥
 */
export async function importKey(keyId: string, base64Key: string): Promise<void> {
  const keyBytes = base64ToUint8Array(base64Key);
  if (keyBytes.length !== 32) {
    throw new Error('Invalid key length: expected 32 bytes for AES-256');
  }
  keyStore.set(keyId, keyBytes);
}

/**
 * 从环境变量加载密钥
 */
export async function loadKeysFromEnv(): Promise<void> {
  // 从环境变量加载密钥
  // 格式: ENCRYPTION_KEY_xxx=base64EncodedKey
  const envKeys = Deno.env.toObject();

  for (const [key, value] of Object.entries(envKeys)) {
    if (key.startsWith('ENCRYPTION_KEY_')) {
      const keyId = key.replace('ENCRYPTION_KEY_', '');
      try {
        await importKey(keyId, value);
        console.log(`[Crypto] Loaded key: ${keyId}`);
      } catch (error) {
        console.error(`[Crypto] Failed to load key ${keyId}:`, error);
      }
    }
  }
}

/**
 * 解密数据
 */
export async function decrypt(
  payload: EncryptedPayload,
  keyId: string
): Promise<string> {
  // 获取密钥
  const keyBytes = keyStore.get(keyId);
  if (!keyBytes) {
    throw new Error(`Key not found: ${keyId}`);
  }

  // 解码 base64
  const iv = base64ToUint8Array(payload.iv);
  const encryptedData = base64ToUint8Array(payload.data);
  const tag = base64ToUint8Array(payload.tag);

  // 合并加密数据和标签（Web Crypto API 需要）
  const ciphertext = new Uint8Array(encryptedData.length + tag.length);
  ciphertext.set(encryptedData);
  ciphertext.set(tag, encryptedData.length);

  // 导入密钥
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // 解密
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128, // 16 bytes = 128 bits
    },
    cryptoKey,
    ciphertext
  );

  // 转换为字符串
  return new TextDecoder().decode(decrypted);
}

/**
 * 加密数据（用于返回加密的结果）
 */
export async function encrypt(
  plaintext: string,
  keyId: string
): Promise<EncryptedPayload> {
  // 获取密钥
  const keyBytes = keyStore.get(keyId);
  if (!keyBytes) {
    throw new Error(`Key not found: ${keyId}`);
  }

  // 生成随机 IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 导入密钥
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // 加密
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128,
    },
    cryptoKey,
    encoded
  );

  // 分离加密数据和标签
  const ciphertextArray = new Uint8Array(ciphertext);
  const encryptedData = ciphertextArray.slice(0, -16);
  const tag = ciphertextArray.slice(-16);

  return {
    iv: uint8ArrayToBase64(iv),
    data: uint8ArrayToBase64(encryptedData),
    tag: uint8ArrayToBase64(tag),
    algorithm: 'aes-256-gcm',
  };
}

/**
 * 验证加密数据格式
 */
export function validateEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  if (!payload || typeof payload !== 'object') return false;

  const p = payload as Record<string, unknown>;

  return (
    typeof p.iv === 'string' &&
    typeof p.data === 'string' &&
    typeof p.tag === 'string' &&
    p.algorithm === 'aes-256-gcm'
  );
}

/**
 * 安全地清除密钥
 */
export function clearKey(keyId: string): void {
  const key = keyStore.get(keyId);
  if (key) {
    // 用零覆盖密钥内容
    key.fill(0);
    keyStore.delete(keyId);
  }
}

/**
 * 清除所有密钥
 */
export function clearAllKeys(): void {
  for (const [keyId] of keyStore) {
    clearKey(keyId);
  }
}
