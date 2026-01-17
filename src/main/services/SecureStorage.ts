// ============================================================================
// Secure Storage Service
// Encrypted storage for sensitive data like tokens
// ============================================================================

import Store from 'electron-store';
import crypto from 'crypto';
import { app } from 'electron';
import os from 'os';
import keytar from 'keytar';

// Keychain constants for persistent storage (survives app reinstall)
const KEYCHAIN_SERVICE = 'code-agent';
const KEYCHAIN_ACCOUNT_SESSION = 'supabase-session';
const KEYCHAIN_ACCOUNT_SETTINGS = 'user-settings';

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
}

// Generate a machine-specific encryption key
function generateEncryptionKey(): string {
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
      console.error('Failed to save session to Keychain:', e);
    }
  }

  // Get session from Keychain
  async getSessionFromKeychain(): Promise<string | null> {
    try {
      return await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION);
    } catch (e) {
      console.error('Failed to get session from Keychain:', e);
      return null;
    }
  }

  // Clear session from Keychain (called when clearing cache)
  async clearSessionFromKeychain(): Promise<void> {
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SESSION);
    } catch (e) {
      console.error('Failed to clear session from Keychain:', e);
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
      console.error('Failed to save settings to Keychain:', e);
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
      console.error('Failed to get settings from Keychain:', e);
      return null;
    }
  }

  // Clear settings from Keychain (called when clearing cache)
  async clearSettingsFromKeychain(): Promise<void> {
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SETTINGS);
    } catch (e) {
      console.error('Failed to clear settings from Keychain:', e);
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
