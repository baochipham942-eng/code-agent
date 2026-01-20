// ============================================================================
// Secure Storage Service
// Encrypted storage for sensitive data like tokens
// Uses Electron safeStorage for OS-level encryption
// ============================================================================

import Store from 'electron-store';
import crypto from 'crypto';
import { app, safeStorage } from 'electron';
import os from 'os';
import keytar from 'keytar';
import { createLogger } from '../infra/logger';

const logger = createLogger('SecureStorage');

// Keychain constants for persistent storage (survives app reinstall)
const KEYCHAIN_SERVICE = 'code-agent';
const KEYCHAIN_ACCOUNT_SESSION = 'supabase-session';
const KEYCHAIN_ACCOUNT_SETTINGS = 'user-settings';
const KEYCHAIN_ACCOUNT_APIKEYS = 'api-keys'; // New: API keys in Keychain

// Storage keys use dot notation by design (e.g., 'supabase.session')
// eslint-disable-next-line @typescript-eslint/naming-convention
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
}

/**
 * Generate encryption key using Electron safeStorage
 * Falls back to hostname-based key if safeStorage unavailable
 */
function generateEncryptionKey(): string {
  // Try to use safeStorage for secure key derivation
  if (safeStorage.isEncryptionAvailable()) {
    try {
      // Use a fixed seed encrypted by OS keychain
      const seed = 'code-agent-encryption-key-v2';
      const encrypted = safeStorage.encryptString(seed);
      // Use first 32 bytes of encrypted data as key
      return encrypted.toString('hex').slice(0, 32);
    } catch (e) {
      logger.warn(' safeStorage encryption failed, using fallback:', e);
    }
  }

  // Fallback: hostname-based key (less secure but works everywhere)
  logger.warn(' Using hostname-based encryption key (less secure)');
  const machineId = `${os.hostname()}-${os.userInfo().username}-${app.getPath('userData')}`;
  return crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32);
}

class SecureStorageService {
  private store: Store<SecureStorageData>;
  private encryptionKey: string;

  constructor() {
    this.encryptionKey = generateEncryptionKey();

    this.store = new Store<SecureStorageData>({
      name: 'secure-storage',
      encryptionKey: this.encryptionKey,
      clearInvalidConfig: true,
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
  clearAuthData(): void {
    this.store.delete('supabase.access_token');
    this.store.delete('supabase.refresh_token');
    this.store.delete('supabase.session');
    this.store.delete('auth.quick_token');
    this.store.delete('auth.user');
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
    try {
      const apiKeys: Record<string, string> = {};
      for (const [provider, key] of this.apiKeyCache) {
        apiKeys[provider] = key;
      }

      if (Object.keys(apiKeys).length > 0) {
        const json = JSON.stringify(apiKeys);
        // Encrypt with safeStorage if available
        if (safeStorage.isEncryptionAvailable()) {
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
    try {
      const stored = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_APIKEYS);
      if (!stored) return;

      let json: string;
      // Try to decrypt with safeStorage
      if (safeStorage.isEncryptionAvailable()) {
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
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION, session);
    } catch (e) {
      logger.error('Failed to save session to Keychain:', e);
    }
  }

  // Get session from Keychain
  async getSessionFromKeychain(): Promise<string | null> {
    try {
      return await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION);
    } catch (e) {
      logger.error('Failed to get session from Keychain:', e);
      return null;
    }
  }

  // Clear session from Keychain (called when clearing cache)
  async clearSessionFromKeychain(): Promise<void> {
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION);
    } catch (e) {
      logger.error('Failed to clear session from Keychain:', e);
    }
  }

  // ========== User Settings Keychain Methods (persist across reinstalls) ==========

  // Save user settings to Keychain
  async saveSettingsToKeychain(settings: Record<string, unknown>): Promise<void> {
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
