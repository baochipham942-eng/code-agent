// ============================================================================
// Secure Storage Service
// Encrypted storage for sensitive data like tokens
// ============================================================================

import Store from 'electron-store';
import crypto from 'crypto';
import { app } from 'electron';
import os from 'os';

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
