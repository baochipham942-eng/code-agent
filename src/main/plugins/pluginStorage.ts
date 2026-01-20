// ============================================================================
// Plugin Storage - Persistent storage for plugins using DatabaseService
// ============================================================================

import { getDatabase } from '../services';
import type { PluginStorage } from './types';

/**
 * Create a persistent storage interface for a plugin
 * Uses DatabaseService's user_preferences table for persistence
 */
export function createPluginStorage(pluginId: string): PluginStorage {
  const prefix = `plugin:${pluginId}:`;

  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const db = getDatabase();
        if (!db) return undefined;

        const fullKey = prefix + key;
        return db.getPreference<T>(fullKey);
      } catch {
        return undefined;
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      try {
        const db = getDatabase();
        if (!db) return;

        const fullKey = prefix + key;
        db.setPreference(fullKey, value);
      } catch (err) {
        console.error(`Plugin storage set error for ${pluginId}:`, err);
      }
    },

    async delete(key: string): Promise<void> {
      try {
        const db = getDatabase();
        if (!db) return;

        const fullKey = prefix + key;
        // Delete by setting to null (will be handled by the DB)
        db.setPreference(fullKey, null);
      } catch (err) {
        console.error(`Plugin storage delete error for ${pluginId}:`, err);
      }
    },

    async clear(): Promise<void> {
      try {
        const db = getDatabase();
        if (!db) return;

        // Get all preferences and filter by prefix
        const all = db.getAllPreferences();
        for (const key of Object.keys(all)) {
          if (key.startsWith(prefix)) {
            db.setPreference(key, null);
          }
        }
      } catch (err) {
        console.error(`Plugin storage clear error for ${pluginId}:`, err);
      }
    },
  };
}

/**
 * Initialize plugin storage table - no longer needed as we use user_preferences
 * Kept for backwards compatibility
 */
export function initPluginStorageTable(): void {
  // No-op: We now use user_preferences table which is already created by DatabaseService
}
