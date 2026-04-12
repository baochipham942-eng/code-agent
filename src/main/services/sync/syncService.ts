// ============================================================================
// Sync Service
// Handles data synchronization between local SQLite and Supabase
// ============================================================================

import {
  getSupabase,
  isSupabaseInitialized,
  type DeviceRow,
  type SessionRow,
  type MessageRow,
  type UserPreferenceRow,
} from '../infra';
import { getDatabase } from '../core';
import { getAuthService } from '../auth';
import { getSecureStorage } from '../core';
import type { SyncStatus, SyncConflict, DeviceInfo, ModelProvider, Message } from '../../../shared/types';
import type { StoredSession } from '../core';
import { createLogger } from '../infra/logger';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../../shared/constants';
import { Disposable, getServiceRegistry } from '../serviceRegistry';

const logger = createLogger('SyncService');

export interface SyncResult {
  success: boolean;
  pushed: number;
  pulled: number;
  conflicts: SyncConflict[];
  error?: string;
}

type SyncStatusCallback = (status: SyncStatus) => void;

class SyncService implements Disposable {
  private deviceId: string;
  private deviceName: string;
  private syncCursor: number = 0;
  private isSyncing: boolean = false;
  private isEnabled: boolean = false;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private pendingChanges: number = 0;
  private lastSyncAt: number | null = null;
  private lastError: string | undefined;
  private onStatusChangeCallbacks: SyncStatusCallback[] = [];
  private conflicts: SyncConflict[] = [];

  constructor() {
    const secureStorage = getSecureStorage();
    this.deviceId = secureStorage.getDeviceId();
    this.deviceName = secureStorage.getDeviceName();
  }

  addStatusChangeCallback(callback: SyncStatusCallback): () => void {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      const index = this.onStatusChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.onStatusChangeCallbacks.splice(index, 1);
      }
    };
  }

  private notifyStatusChange(): void {
    const status = this.getStatus();
    this.onStatusChangeCallbacks.forEach((callback) => {
      try {
        callback(status);
      } catch (err) {
        logger.error('Sync status callback error', err as Error);
      }
    });
  }

  getStatus(): SyncStatus {
    return {
      isEnabled: this.isEnabled,
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt,
      pendingChanges: this.pendingChanges,
      error: this.lastError,
    };
  }

  async initialize(): Promise<void> {
    if (!isSupabaseInitialized()) {
      return;
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return;
    }

    // Register device and get sync cursor
    await this.registerDevice(user.id);
  }

  async registerDevice(userId: string): Promise<DeviceInfo | null> {
    if (!isSupabaseInitialized()) {
      return null;
    }

    const supabase = getSupabase();
    const platform = process.platform;

    // Upsert device
    // TODO: Supabase 类型系统限制，upsert 需要 as any
    const { data: dataRaw, error } = await supabase
      .from('devices')
      .upsert(
        {
          user_id: userId,
          device_id: this.deviceId,
          device_name: this.deviceName,
          platform,
          last_active_at: new Date().toISOString(),
        } as any,
        {
          onConflict: 'user_id,device_id',
        }
      )
      .select()
      .single();

    if (error) {
      logger.error('Failed to register device', { error });
      return null;
    }

    const data = dataRaw as DeviceRow;
    this.syncCursor = data.sync_cursor || 0;

    return {
      id: data.id,
      deviceId: data.device_id,
      deviceName: data.device_name || '',
      platform: data.platform || '',
      lastActiveAt: new Date(data.last_active_at).getTime(),
      isCurrent: true,
    };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (!isSupabaseInitialized()) {
      return [];
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return [];
    }

    const supabase = getSupabase();
    const { data: dataRaw, error } = await supabase
      .from('devices')
      .select('*')
      .eq('user_id', user.id)
      .order('last_active_at', { ascending: false });

    if (error) {
      logger.error('Failed to list devices', { error });
      return [];
    }

    const data = (dataRaw || []) as DeviceRow[];
    return data.map((d) => ({
      id: d.id,
      deviceId: d.device_id,
      deviceName: d.device_name || '',
      platform: d.platform || '',
      lastActiveAt: new Date(d.last_active_at).getTime(),
      isCurrent: d.device_id === this.deviceId,
    }));
  }

  async removeDevice(deviceId: string): Promise<void> {
    if (!isSupabaseInitialized()) {
      return;
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return;
    }

    const supabase = getSupabase();
    await supabase
      .from('devices')
      .delete()
      .eq('user_id', user.id)
      .eq('device_id', deviceId);
  }

  async startAutoSync(intervalMs: number = 5 * 60 * 1000): Promise<void> {
    if (this.syncInterval || !isSupabaseInitialized()) {
      return;
    }

    this.isEnabled = true;
    this.notifyStatusChange();

    // Sync immediately
    await this.sync();

    // Set up interval
    this.syncInterval = setInterval(() => {
      this.sync().catch((err) => logger.error('Sync interval error', err));
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isEnabled = false;
    this.notifyStatusChange();
  }

  async sync(): Promise<SyncResult> {
    if (this.isSyncing) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: 'Sync already in progress',
      };
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: 'Not authenticated',
      };
    }

    if (!isSupabaseInitialized()) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: 'Supabase not initialized',
      };
    }

    this.isSyncing = true;
    this.lastError = undefined;
    this.notifyStatusChange();

    try {
      // Pull from cloud
      const pullResult = await this.pullFromCloud(user.id);

      // Push to cloud
      const pushResult = await this.pushToCloud(user.id);

      // Only update sync cursor (used for sessions + pull) if push succeeded
      if (pushResult.success) {
        await this.updateSyncCursor(user.id);
      }

      this.lastSyncAt = Date.now();
      this.pendingChanges = 0;
      this.conflicts = pullResult.conflicts;

      return {
        success: true,
        pushed: pushResult.count,
        pulled: pullResult.count,
        conflicts: pullResult.conflicts,
      };
    } catch (error) {
      this.lastError = (error as Error).message;
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: this.lastError,
      };
    } finally {
      this.isSyncing = false;
      this.notifyStatusChange();
    }
  }

  async forceFullSync(): Promise<SyncResult> {
    this.syncCursor = 0;
    return this.sync();
  }

  private async pullFromCloud(
    userId: string
  ): Promise<{ count: number; conflicts: SyncConflict[] }> {
    const supabase = getSupabase();
    const db = getDatabase();
    const conflicts: SyncConflict[] = [];
    let count = 0;

    // Pull sessions
    const { data: remoteSessionsRaw } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', this.syncCursor)
      .order('updated_at', { ascending: true });

    const remoteSessions = (remoteSessionsRaw || []) as SessionRow[];

    for (const remote of remoteSessions) {
      try {
        const local = db.getSession(remote.id, { includeDeleted: true });

        if (remote.is_deleted) {
          if (local && remote.updated_at > local.updatedAt) {
            db.deleteSession(remote.id, {
              deletedAt: remote.updated_at,
              syncOrigin: 'remote',
            });
            count++;
          }
          continue;
        }

        if (!local) {
          // New record from cloud
          // 云端数据类型与本地类型不完全匹配，需要类型断言
          db.createSessionWithId(remote.id, {
            title: remote.title,
            modelConfig: {
              provider: (remote.model_provider as ModelProvider) || DEFAULT_PROVIDER,
              model: remote.model_name || DEFAULT_MODEL,
            },
            workingDirectory: remote.working_directory || undefined,
            createdAt: remote.created_at,
            updatedAt: remote.updated_at,
            isDeleted: false,
          }, {
            syncOrigin: 'remote',
          });
          count++;
        } else if (remote.updated_at > local.updatedAt) {
          // Remote is newer
          if (remote.source_device_id !== this.deviceId) {
            // Check for conflict
            if (local.updatedAt > this.syncCursor) {
              // Local also modified - conflict
              conflicts.push({
                id: remote.id,
                table: 'sessions',
                localRecord: local,
                remoteRecord: remote,
                conflictType: 'update',
              });
            } else {
              // No conflict, update local (preserve remote timestamp)
              db.updateSession(remote.id, {
                title: remote.title,
                modelConfig: {
                  provider: (remote.model_provider as ModelProvider) || DEFAULT_PROVIDER,
                  model: remote.model_name || DEFAULT_MODEL,
                },
                workingDirectory: remote.working_directory || undefined,
                createdAt: remote.created_at as number,
                updatedAt: remote.updated_at as number,
              }, {
                syncOrigin: 'remote',
                isDeleted: false,
              });
              count++;
            }
          }
        }
      } catch (err) {
        logger.error('Error pulling session', { sessionId: remote.id, error: err });
      }
    }

    // Pull messages
    const { data: remoteMessagesRaw } = await supabase
      .from('messages')
      .select('*')
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .gt('updated_at', this.syncCursor)
      .order('updated_at', { ascending: true })
      .limit(1000);

    const remoteMessages = (remoteMessagesRaw || []) as MessageRow[];

    for (const remote of remoteMessages) {
      try {
        // Check if session exists locally
        const session = db.getSession(remote.session_id);
        if (!session) continue;

        const localMessages = db.getMessages(remote.session_id);
        const localMsg = localMessages.find((m) => m.id === remote.id);

        if (!localMsg) {
          // New message from cloud
          // 云端消息类型需要断言为本地类型
          db.addMessage(remote.session_id, {
            id: remote.id,
            role: remote.role as Message['role'],
            content: remote.content,
            timestamp: remote.timestamp,
            toolCalls: remote.tool_calls as Message['toolCalls'],
            toolResults: remote.tool_results as Message['toolResults'],
          }, {
            skipTimestampUpdate: true,
            syncOrigin: 'remote',
          });
          count++;
        }
      } catch (err) {
        logger.error('Error pulling message', { messageId: remote.id, error: err });
      }
    }

    // Pull user preferences
    const { data: remotePrefsRaw } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', this.syncCursor);

    const remotePrefs = (remotePrefsRaw || []) as UserPreferenceRow[];

    for (const remote of remotePrefs) {
      try {
        db.setPreference(remote.key, remote.value);
        count++;
      } catch (err) {
        logger.error('Error pulling preference', { key: remote.key, error: err });
      }
    }

    return { count, conflicts };
  }

  private async pushToCloud(userId: string): Promise<{ count: number; success: boolean }> {
    const supabase = getSupabase();
    const db = getDatabase();
    let count = 0;
    let sessionPushFailed = false;

    const pendingSessions = db.getUnsyncedSessions(1000);

    if (pendingSessions.length > 0) {
      const { error } = await supabase.from('sessions').upsert(
        pendingSessions.map((s) => ({
          id: s.id,
          user_id: userId,
          title: s.title,
          generation_id: null, // deprecated field, kept for cloud schema compatibility
          model_provider: s.modelConfig.provider,
          model_name: s.modelConfig.model,
          working_directory: s.workingDirectory || null,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          is_deleted: s.isDeleted ?? false,
          source_device_id: this.deviceId,
          // TODO: Supabase upsert 类型限制
        })) as any,
        { onConflict: 'id' }
      );

      if (!error) {
        db.markSessionsSynced(pendingSessions.map((s) => s.id));
        count += pendingSessions.length;
      } else {
        logger.error('Error pushing sessions', { error });
        sessionPushFailed = true;
      }
    }

    // Push unsynced messages (synced_at IS NULL)
    const unsyncedMessages = db.getUnsyncedMessages(1000);

    if (unsyncedMessages.length > 0) {
      // Batch upsert in chunks of 200
      const batchSize = 200;
      for (let i = 0; i < unsyncedMessages.length; i += batchSize) {
        const batch = unsyncedMessages.slice(i, i + batchSize);

        const { error } = await supabase.from('messages').upsert(
          batch.map((m) => ({
            id: m.id,
            session_id: m.sessionId,
            user_id: userId,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            tool_calls: m.toolCalls || null,
            tool_results: m.toolResults || null,
            updated_at: Date.now(),
            source_device_id: this.deviceId,
            // TODO: Supabase upsert 类型限制
          })) as any,
          { onConflict: 'id' }
        );

        if (!error) {
          // Only mark as synced after successful push
          db.markMessagesSynced(batch.map((m) => m.id));
          count += batch.length;
        } else {
          logger.error('Error pushing messages', { error });
          // Failed messages retain synced_at = NULL, will be retried next sync
        }
      }
    }

    return { count, success: !sessionPushFailed };
  }

  private async updateSyncCursor(userId: string): Promise<void> {
    const supabase = getSupabase();
    const newCursor = Date.now();

    await supabase
      .from('devices')
      .update({
        sync_cursor: newCursor,
        last_active_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('device_id', this.deviceId);

    this.syncCursor = newCursor;
  }

  async resolveConflict(
    conflictId: string,
    resolution: 'local' | 'remote' | 'merge'
  ): Promise<void> {
    const conflict = this.conflicts.find((c) => c.id === conflictId);
    if (!conflict) return;

    const db = getDatabase();
    const supabase = getSupabase();
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) return;

    if (resolution === 'local') {
      // Push local version to cloud
      if (conflict.table === 'sessions') {
        // 冲突记录类型断言为本地会话类型
        const local = conflict.localRecord as StoredSession;
        // TODO: Supabase update 类型限制
        await (supabase.from('sessions') as any).update({
          title: local.title,
          updated_at: Date.now(),
          source_device_id: this.deviceId,
        }).eq('id', conflict.id);
      }
    } else if (resolution === 'remote') {
      // Apply remote version locally
      if (conflict.table === 'sessions') {
        // 冲突记录类型断言为云端会话类型
        const remote = conflict.remoteRecord as SessionRow;
        db.updateSession(conflict.id, {
          title: remote.title,
          updatedAt: remote.updated_at as number,
        }, {
          syncOrigin: 'remote',
          isDeleted: remote.is_deleted,
        });
      }
    }

    // Remove from conflicts list
    this.conflicts = this.conflicts.filter((c) => c.id !== conflictId);
    this.notifyStatusChange();
  }

  async dispose(): Promise<void> {
    this.stopAutoSync();
    this.onStatusChangeCallbacks = [];
    this.conflicts = [];
  }

  incrementPendingChanges(): void {
    this.pendingChanges++;
    this.notifyStatusChange();
  }
}

// Singleton
let syncServiceInstance: SyncService | null = null;

export function getSyncService(): SyncService {
  if (!syncServiceInstance) {
    syncServiceInstance = new SyncService();
  }
  return syncServiceInstance;
}

getServiceRegistry().register('SyncService', getSyncService());
export type { SyncService };
