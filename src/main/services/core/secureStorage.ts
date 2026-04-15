// ============================================================================
// Secure Storage Service
// Encrypted storage for sensitive data like tokens
// Uses Electron safeStorage for OS-level encryption
// ============================================================================

import crypto from 'crypto';
import { app, safeStorage } from '../../platform';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
// 延迟加载 keytar，处理 native 模块版本不匹配的情况
// CLI 模式下 keytar 为 Electron headers 编译，系统 Node.js 加载会 segfault（不是 JS 异常，try-catch 无法捕获）
// 必须在 require 之前用环境变量判断，CLI 模式直接跳过
// 降级后 Keychain 功能不可用，但 electron-store 备份仍可用
let keytar: typeof import('keytar') | null = null;
if (!process.env.CODE_AGENT_CLI_MODE) {
  try {
    keytar = require('keytar');
  } catch (error) {
    console.warn('[SecureStorage] keytar not available:', (error as Error).message?.split('\n')[0]);
  }
}

import { createLogger } from '../infra/logger';

const logger = createLogger('SecureStorage');

// Keychain constants for persistent storage (survives app reinstall)
const KEYCHAIN_SERVICE = 'code-agent';
const KEYCHAIN_ACCOUNT_SESSION = 'supabase-session';
const KEYCHAIN_ACCOUNT_SETTINGS = 'user-settings';
const KEYCHAIN_ACCOUNT_APIKEYS = 'api-keys'; // New: API keys in Keychain

// Storage keys use dot notation by design (e.g., 'supabase.session')
 
interface SecureStorageData {
  // Auth tokens
  'supabase.access_token'?: string;
  'supabase.refresh_token'?: string;
  'supabase.session'?: string;
  // Device info
  'device.id'?: string;
  'device.name'?: string;
  // Quick login
  'auth.quick_token'?: string;
  // User info cache
  'auth.user'?: string;
  // Saved login credentials (remember password)
  'auth.saved_email'?: string;
  'auth.saved_password'?: string;
  'auth.remember_enabled'?: string;
  // Developer settings (persisted across data clears)
  'settings.devModeAutoApprove'?: string;
  // API Keys - now stored encrypted via safeStorage
  'apikey.deepseek'?: string;
  'apikey.claude'?: string;
  'apikey.openai'?: string;
  'apikey.groq'?: string;
  'apikey.zhipu'?: string;
  'apikey.qwen'?: string;
  'apikey.moonshot'?: string;
  'apikey.perplexity'?: string;
  'apikey.openrouter'?: string;
  // Service API Keys (non-model)
  'apikey.brave'?: string;
  'apikey.github'?: string;
  'apikey.langfuse_public'?: string;
  'apikey.langfuse_secret'?: string;
  // Integration configs (stored as JSON strings)
  'integration.jira'?: string;
  // Allow arbitrary integration keys
  [key: `integration.${string}`]: string | undefined;
}

/**
 * File-stored encryption key (`~/.code-agent/.secure-key`).
 *
 * 2026-04-15 修复：原实现从 hostname+userDataPath 派生 key，看似稳定但 bundled
 * webServer 下 `app.getPath('userData')` 可能 resolve 不同值，导致 decrypt 失败；
 * 配合 `clearInvalidConfig: true` 就是每次重装/重启都静默清空 session 的地狱组合。
 *
 * 新方案：首次运行随机生成 32 字节，写入用户数据目录的 .secure-key 文件，之后
 * 永久复用。文件权限 0o600（仅用户可读）。重装 app 不会动用户数据目录 → 彻底稳定。
 */
function loadPersistentEncryptionKey(): string {
  const dataDir = resolveStoreBaseDir();
  const keyFile = path.join(dataDir, '.secure-key');

  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, 'utf-8').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
  } catch (err) {
    logger.warn('Failed to read persistent secure-key file, regenerating', { err });
  }

  // 首次运行（或文件损坏）: 生成新 key 并落盘
  fs.mkdirSync(dataDir, { recursive: true });
  const fresh = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  fs.writeFileSync(keyFile, fresh, { encoding: 'utf-8', mode: 0o600 });
  logger.info('Generated fresh persistent encryption key', { keyFile });
  return fresh;
}

/**
 * Legacy hostname-based key — 仅用于从旧格式迁移已有的 secure-storage.json。
 * 新写入永远使用 loadPersistentEncryptionKey()。
 */
function deriveLegacyEncryptionKey(): string {
  let userDataPath = '';
  try {
    userDataPath = app?.getPath?.('userData') || '';
  } catch {
    userDataPath = os.homedir();
  }
  const machineId = `${os.hostname()}-${os.userInfo().username}-${userDataPath}`;
  return crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32);
}

interface LocalEncryptedStoreOptions {
  name: string;
  encryptionKey: string;
  /**
   * Legacy 密钥（可选）。用于从旧的派生 key 平滑迁移：
   * 如果用新 key decrypt 失败，会回退用 legacy key 再试；成功后用新 key 重写文件。
   * 永远不会因 decrypt 失败而清空文件。
   */
  legacyEncryptionKey?: string;
}

interface EncryptedStorePayload {
  iv: string;
  tag: string;
  data: string;
}

function resolveStoreBaseDir(): string {
  try {
    const userDataPath = app?.getPath?.('userData');
    if (userDataPath) return userDataPath;
  } catch {
    // Electron app path is unavailable in CLI mode.
  }

  const dataDir = process.env.CODE_AGENT_DATA_DIR || getUserConfigDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

class LocalEncryptedStore<T extends object> {
  private filePath: string;
  private key: Buffer;
  private legacyKey: Buffer | null;
  private data: Partial<T>;

  constructor(options: LocalEncryptedStoreOptions) {
    this.filePath = path.join(resolveStoreBaseDir(), `${options.name}.json`);
    this.key = crypto.createHash('sha256').update(options.encryptionKey).digest();
    this.legacyKey = options.legacyEncryptionKey
      ? crypto.createHash('sha256').update(options.legacyEncryptionKey).digest()
      : null;
    this.data = this.load();
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.data[key] as T[K] | undefined;
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this.data[key] = value;
    this.save();
  }

  delete<K extends keyof T>(key: K): void {
    delete this.data[key];
    this.save();
  }

  has<K extends keyof T>(key: K): boolean {
    return this.data[key] !== undefined;
  }

  private load(): Partial<T> {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8').trim();
    } catch (error) {
      logger.warn('Failed to read secure storage file', { error });
      return {};
    }
    if (!raw) return {};

    // 优先用新 key
    try {
      const decrypted = this.decryptWith(raw, this.key);
      return JSON.parse(decrypted) as Partial<T>;
    } catch (primaryErr) {
      // Fallback: 从旧派生 key 迁移
      if (this.legacyKey) {
        try {
          const decrypted = this.decryptWith(raw, this.legacyKey);
          const parsed = JSON.parse(decrypted) as Partial<T>;
          logger.info('Decrypted secure storage with legacy key, re-encrypting with new key');
          // 立即用新 key 重写，下次就走主路径
          this.data = parsed;
          this.save();
          return parsed;
        } catch (legacyErr) {
          logger.warn('Both new and legacy keys failed to decrypt secure storage — file will NOT be wiped', {
            primaryErr: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
            legacyErr: legacyErr instanceof Error ? legacyErr.message : String(legacyErr),
          });
        }
      } else {
        logger.warn('Failed to decrypt secure storage and no legacy key available — file will NOT be wiped', {
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
      }
      // 关键：decrypt 失败时返回空 Partial，但绝不覆盖磁盘上的文件
      // 这样下次启动还能再试一次，用户数据不会静默丢失
      return {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = this.encrypt(JSON.stringify(this.data));
    fs.writeFileSync(this.filePath, encrypted, { encoding: 'utf-8', mode: 0o600 });
  }

  private encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload: EncryptedStorePayload = {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: data.toString('base64'),
    };

    return JSON.stringify(payload);
  }

  private decryptWith(value: string, key: Buffer): string {
    const payload = JSON.parse(value) as EncryptedStorePayload;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  }
}

class SecureStorageService {
  private store: LocalEncryptedStore<SecureStorageData>;
  private encryptionKey: string;

  constructor() {
    // 新方案：从 ~/.code-agent/.secure-key 读取持久化 key（首次运行自动生成）
    this.encryptionKey = loadPersistentEncryptionKey();

    this.store = new LocalEncryptedStore<SecureStorageData>({
      name: 'secure-storage',
      encryptionKey: this.encryptionKey,
      // legacyKey：用旧的 hostname 派生方案，把历史加密文件平滑迁移到新 key
      legacyEncryptionKey: deriveLegacyEncryptionKey(),
    });
  }

  // Get value
  get(key: keyof SecureStorageData): string | undefined {
    return this.store.get(key);
  }

  // Set value
  set(key: keyof SecureStorageData, value: string): void {
    this.store.set(key, value);
  }

  // Delete value
  delete(key: keyof SecureStorageData): void {
    this.store.delete(key);
  }

  // Check if key exists
  has(key: keyof SecureStorageData): boolean {
    return this.store.has(key);
  }

  // Clear all auth data (for logout)
  // Note: Does NOT clear saved credentials (remember password)
  clearAuthData(): void {
    this.store.delete('supabase.access_token');
    this.store.delete('supabase.refresh_token');
    this.store.delete('supabase.session');
    this.store.delete('auth.quick_token');
    this.store.delete('auth.user');
  }

  // ========== Saved Login Credentials (Remember Password) ==========

  /**
   * Save login credentials for quick re-login
   * @param email User's email
   * @param password User's password (will be encrypted)
   */
  saveLoginCredentials(email: string, password: string): void {
    this.store.set('auth.saved_email', email);
    this.store.set('auth.saved_password', password);
    this.store.set('auth.remember_enabled', 'true');
    logger.info(' Saved login credentials for:', email);
  }

  /**
   * Get saved login credentials
   * @returns { email, password } or null if not saved
   */
  getSavedCredentials(): { email: string; password: string } | null {
    const enabled = this.store.get('auth.remember_enabled');
    if (enabled !== 'true') return null;

    const email = this.store.get('auth.saved_email');
    const password = this.store.get('auth.saved_password');

    if (email && password) {
      return { email, password };
    }
    return null;
  }

  /**
   * Clear saved login credentials
   */
  clearSavedCredentials(): void {
    this.store.delete('auth.saved_email');
    this.store.delete('auth.saved_password');
    this.store.delete('auth.remember_enabled');
    logger.info(' Cleared saved login credentials');
  }

  /**
   * Check if remember password is enabled
   */
  isRememberEnabled(): boolean {
    return this.store.get('auth.remember_enabled') === 'true';
  }

  // ========== API Key Management (Keychain + safeStorage) ==========

  // API key cache to avoid frequent Keychain access
  private apiKeyCache: Map<string, string> = new Map();

  /**
   * Set API key for a provider
   * Stores in both Keychain (persistent) and local cache
   */
  setApiKey(provider: string, apiKey: string): void {
    // Update cache immediately
    this.apiKeyCache.set(provider, apiKey);

    // Store in Keychain asynchronously (persistent storage)
    this.saveApiKeysToKeychain().catch(e => {
      logger.error(' Failed to save API key to Keychain:', e);
    });

    // Also store in electron-store as backup (encrypted)
    const key = `apikey.${provider}` as keyof SecureStorageData;
    this.store.set(key, apiKey);
  }

  /**
   * Get API key for a provider
   * Checks cache first, then Keychain, then electron-store
   */
  getApiKey(provider: string): string | undefined {
    // Check cache first
    const cached = this.apiKeyCache.get(provider);
    if (cached) return cached;

    // Check electron-store (backup)
    const key = `apikey.${provider}` as keyof SecureStorageData;
    const stored = this.store.get(key);
    if (stored) {
      this.apiKeyCache.set(provider, stored);
      return stored;
    }

    return undefined;
  }

  /**
   * Delete API key for a provider
   */
  deleteApiKey(provider: string): void {
    this.apiKeyCache.delete(provider);

    const key = `apikey.${provider}` as keyof SecureStorageData;
    this.store.delete(key);

    // Update Keychain
    this.saveApiKeysToKeychain().catch(e => {
      logger.error(' Failed to update Keychain after delete:', e);
    });
  }

  /**
   * Check if API key exists for a provider
   */
  hasApiKey(provider: string): boolean {
    return this.apiKeyCache.has(provider) || this.store.has(`apikey.${provider}` as keyof SecureStorageData);
  }

  /**
   * Get all stored API key providers
   */
  getStoredApiKeyProviders(): string[] {
    const providers: string[] = [];
    // Model providers + service API keys
    const allKeys = [
      // Model providers
      'deepseek', 'claude', 'openai', 'groq', 'zhipu', 'qwen', 'moonshot', 'perplexity', 'openrouter',
      // Service API keys
      'brave', 'github', 'langfuse_public', 'langfuse_secret',
    ];
    for (const provider of allKeys) {
      if (this.hasApiKey(provider)) {
        providers.push(provider);
      }
    }
    return providers;
  }

  /**
   * Save all API keys to Keychain
   * Keys are encrypted with safeStorage before storing
   */
  private async saveApiKeysToKeychain(): Promise<void> {
    if (!keytar) return;
    try {
      const apiKeys: Record<string, string> = {};
      for (const [provider, key] of this.apiKeyCache) {
        apiKeys[provider] = key;
      }

      if (Object.keys(apiKeys).length > 0) {
        const json = JSON.stringify(apiKeys);
        // Encrypt with safeStorage if available (not in CLI mode)
        if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(json);
          await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_APIKEYS, encrypted.toString('base64'));
        } else {
          // Fallback: store directly (still protected by Keychain)
          await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_APIKEYS, json);
        }
      }
    } catch (e) {
      logger.error(' Failed to save API keys to Keychain:', e);
    }
  }

  /**
   * Load API keys from Keychain on startup
   */
  async loadApiKeysFromKeychain(): Promise<void> {
    if (!keytar) return;
    try {
      const stored = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_APIKEYS);
      if (!stored) return;

      let json: string;
      // Try to decrypt with safeStorage (not available in CLI mode)
      if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(stored, 'base64');
          json = safeStorage.decryptString(buffer);
        } catch {
          // Might be unencrypted (legacy), try direct parse
          json = stored;
        }
      } else {
        json = stored;
      }

      const apiKeys = JSON.parse(json) as Record<string, string>;
      for (const [provider, key] of Object.entries(apiKeys)) {
        this.apiKeyCache.set(provider, key);
        // Also sync to electron-store as backup
        const storeKey = `apikey.${provider}` as keyof SecureStorageData;
        this.store.set(storeKey, key);
      }

      logger.info(' Loaded API keys from Keychain:', Object.keys(apiKeys).join(', '));
    } catch (e) {
      logger.error(' Failed to load API keys from Keychain:', e);
    }
  }

  // Get or generate device ID
  getDeviceId(): string {
    let deviceId = this.store.get('device.id');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      this.store.set('device.id', deviceId);
    }
    return deviceId;
  }

  // Get or generate device name
  getDeviceName(): string {
    let deviceName = this.store.get('device.name');
    if (!deviceName) {
      deviceName = `${os.hostname()} (${os.platform()})`;
      this.store.set('device.name', deviceName);
    }
    return deviceName;
  }

  // For Supabase auth storage adapter
  async getItem(key: string): Promise<string | null> {
    const value = this.store.get(key as keyof SecureStorageData);
    return value ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key as keyof SecureStorageData, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key as keyof SecureStorageData);
  }

  // ========== Keychain Methods (for persistent auth across reinstalls) ==========

  // Save session to Keychain (survives app reinstall)
  async saveSessionToKeychain(session: string): Promise<void> {
    if (!keytar) return;
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION, session);
    } catch (e) {
      logger.error('Failed to save session to Keychain:', e);
    }
  }

  // Get session from Keychain
  async getSessionFromKeychain(): Promise<string | null> {
    if (!keytar) return null;
    try {
      return await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION);
    } catch (e) {
      logger.error('Failed to get session from Keychain:', e);
      return null;
    }
  }

  // Clear session from Keychain (called when clearing cache)
  async clearSessionFromKeychain(): Promise<void> {
    if (!keytar) return;
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION);
    } catch (e) {
      logger.error('Failed to clear session from Keychain:', e);
    }
  }

  // ========== User Settings Keychain Methods (persist across reinstalls) ==========

  // Save user settings to Keychain
  async saveSettingsToKeychain(settings: Record<string, unknown>): Promise<void> {
    if (!keytar) return;
    try {
      await keytar.setPassword(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT_SETTINGS,
        JSON.stringify(settings)
      );
    } catch (e) {
      logger.error('Failed to save settings to Keychain:', e);
    }
  }

  // Get user settings from Keychain
  async getSettingsFromKeychain(): Promise<Record<string, unknown> | null> {
    if (!keytar) return null;
    try {
      const settingsJson = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SETTINGS);
      if (settingsJson) {
        return JSON.parse(settingsJson);
      }
      return null;
    } catch (e) {
      logger.error('Failed to get settings from Keychain:', e);
      return null;
    }
  }

  // Clear settings from Keychain (called when clearing cache)
  async clearSettingsFromKeychain(): Promise<void> {
    if (!keytar) return;
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SETTINGS);
    } catch (e) {
      logger.error('Failed to clear settings from Keychain:', e);
    }
  }
}

// Singleton
let secureStorageInstance: SecureStorageService | null = null;

export function getSecureStorage(): SecureStorageService {
  if (!secureStorageInstance) {
    secureStorageInstance = new SecureStorageService();
  }
  return secureStorageInstance;
}

export type { SecureStorageService };
