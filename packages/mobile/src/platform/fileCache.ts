import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';

export interface CacheEntry {
  key: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  atime: number;
  size: number;
}

export interface CacheInspect {
  previewBytes: number;
  conversationBytes: number;
  protectedBytes: number;
}

export interface CacheClearResult {
  freedBytes: number;
  remainingBytes: number;
  failedEntries: string[];
}

/** Rebuildable preview copies only. Drafts, pairing identity and settings live elsewhere. */
export class FileCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly quota = L.cacheQuotaBytes, private readonly now = Date.now) {}

  inspect(): CacheInspect {
    const previewBytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    return { previewBytes, conversationBytes: 0, protectedBytes: 0 };
  }

  get(key: string): CacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.atime = this.now();
    return entry;
  }

  put(key: string, value: Omit<CacheEntry, 'key' | 'atime' | 'size'>): CacheEntry {
    const size = value.bytes.byteLength;
    if (size > this.quota) throw new Error('STORAGE_FULL');
    this.entries.set(key, { key, name: value.name, mimeType: value.mimeType, bytes: value.bytes, atime: this.now(), size });
    this.evict(key);
    if (this.total() > this.quota) {
      this.entries.delete(key);
      throw new Error('STORAGE_FULL');
    }
    return this.entries.get(key)!;
  }

  clear(): CacheClearResult {
    const previewBytes = this.total();
    const failedEntries: string[] = [];
    for (const key of [...this.entries.keys()]) this.entries.delete(key);
    return { freedBytes: previewBytes, remainingBytes: 0, failedEntries };
  }

  private total(): number {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
  }

  private evict(keep: string): void {
    while (this.total() > this.quota) {
      let victim: CacheEntry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.key === keep) continue;
        if (!victim || entry.atime < victim.atime) victim = entry;
      }
      if (!victim) break;
      this.entries.delete(victim.key);
    }
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
