// ============================================================================
// Cloud Storage Service - 云端存储能力
// ============================================================================

import { getDatabase } from './DatabaseService';
import type { StoredSession } from './DatabaseService';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type CloudProvider = 'github-gist' | 'webdav' | 'custom';

export interface CloudStorageConfig {
  provider: CloudProvider;
  enabled: boolean;
  autoSync: boolean;
  syncInterval: number; // 毫秒
  // GitHub Gist
  githubToken?: string;
  gistId?: string;
  // WebDAV
  webdavUrl?: string;
  webdavUsername?: string;
  webdavPassword?: string;
  // Custom API
  customApiUrl?: string;
  customApiKey?: string;
}

export interface SyncStatus {
  lastSyncAt: number | null;
  lastSyncSuccess: boolean;
  pendingChanges: number;
  syncInProgress: boolean;
  error?: string;
}

export interface ExportData {
  version: string;
  exportedAt: number;
  sessions: StoredSession[];
  messages: Record<string, unknown[]>;
  preferences: Record<string, unknown>;
  knowledge: Record<string, unknown[]>;
}

// ----------------------------------------------------------------------------
// Cloud Storage Service
// ----------------------------------------------------------------------------

export class CloudStorageService {
  private config: CloudStorageConfig;
  private syncStatus: SyncStatus;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.config = {
      provider: 'github-gist',
      enabled: false,
      autoSync: false,
      syncInterval: 5 * 60 * 1000, // 5分钟
    };

    this.syncStatus = {
      lastSyncAt: null,
      lastSyncSuccess: false,
      pendingChanges: 0,
      syncInProgress: false,
    };
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  configure(config: Partial<CloudStorageConfig>): void {
    this.config = { ...this.config, ...config };

    // 重置自动同步
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.config.enabled && this.config.autoSync) {
      this.startAutoSync();
    }
  }

  getConfig(): CloudStorageConfig {
    return { ...this.config };
  }

  getStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  // --------------------------------------------------------------------------
  // Export / Import
  // --------------------------------------------------------------------------

  /**
   * 导出所有数据
   */
  async exportData(): Promise<ExportData> {
    const db = getDatabase();

    const sessions = db.listSessions(1000, 0);
    const messages: Record<string, unknown[]> = {};

    for (const session of sessions) {
      messages[session.id] = db.getMessages(session.id);
    }

    const preferences = db.getAllPreferences();

    // 获取所有项目知识
    const knowledge: Record<string, unknown[]> = {};
    // 注：需要遍历所有项目路径，这里简化处理

    return {
      version: '1.0.0',
      exportedAt: Date.now(),
      sessions,
      messages,
      preferences,
      knowledge,
    };
  }

  /**
   * 导入数据
   */
  async importData(data: ExportData, merge: boolean = true): Promise<{
    imported: number;
    skipped: number;
    errors: string[];
  }> {
    const db = getDatabase();
    const result = { imported: 0, skipped: 0, errors: [] as string[] };

    for (const session of data.sessions) {
      try {
        const existing = db.getSession(session.id);

        if (existing && !merge) {
          result.skipped++;
          continue;
        }

        if (!existing) {
          db.createSession({
            id: session.id,
            title: session.title,
            generationId: session.generationId,
            modelConfig: session.modelConfig,
            workingDirectory: session.workingDirectory,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          });
        }

        // 导入消息
        const sessionMessages = data.messages[session.id] || [];
        for (const msg of sessionMessages) {
          try {
            db.addMessage(session.id, msg as any);
          } catch {
            // 消息可能已存在
          }
        }

        result.imported++;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Session ${session.id}: ${errorMessage}`);
      }
    }

    // 导入偏好设置
    if (data.preferences) {
      for (const [key, value] of Object.entries(data.preferences)) {
        db.setPreference(key, value);
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Cloud Sync - GitHub Gist
  // --------------------------------------------------------------------------

  /**
   * 同步到 GitHub Gist
   */
  async syncToGist(): Promise<boolean> {
    if (!this.config.githubToken) {
      throw new Error('GitHub token not configured');
    }

    this.syncStatus.syncInProgress = true;

    try {
      const data = await this.exportData();
      const content = JSON.stringify(data, null, 2);

      const headers = {
        'Authorization': `Bearer ${this.config.githubToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      };

      if (this.config.gistId) {
        // 更新现有 Gist
        const response = await fetch(
          `https://api.github.com/gists/${this.config.gistId}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              description: 'Code Agent - Session Backup',
              files: {
                'code-agent-backup.json': { content },
              },
            }),
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to update gist: ${response.statusText}`);
        }
      } else {
        // 创建新 Gist
        const response = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            description: 'Code Agent - Session Backup',
            public: false,
            files: {
              'code-agent-backup.json': { content },
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to create gist: ${response.statusText}`);
        }

        const gist = await response.json();
        this.config.gistId = gist.id;
      }

      this.syncStatus.lastSyncAt = Date.now();
      this.syncStatus.lastSyncSuccess = true;
      this.syncStatus.pendingChanges = 0;
      this.syncStatus.error = undefined;

      return true;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Sync failed';
      this.syncStatus.lastSyncSuccess = false;
      this.syncStatus.error = errorMessage;
      throw error;
    } finally {
      this.syncStatus.syncInProgress = false;
    }
  }

  /**
   * 从 GitHub Gist 恢复
   */
  async restoreFromGist(): Promise<ExportData | null> {
    if (!this.config.githubToken || !this.config.gistId) {
      throw new Error('GitHub token or gist ID not configured');
    }

    const response = await fetch(
      `https://api.github.com/gists/${this.config.gistId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.config.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch gist: ${response.statusText}`);
    }

    const gist = await response.json();
    const file = gist.files['code-agent-backup.json'];

    if (!file) {
      return null;
    }

    return JSON.parse(file.content);
  }

  // --------------------------------------------------------------------------
  // Cloud Sync - WebDAV
  // --------------------------------------------------------------------------

  /**
   * 同步到 WebDAV
   */
  async syncToWebDAV(): Promise<boolean> {
    if (!this.config.webdavUrl) {
      throw new Error('WebDAV URL not configured');
    }

    this.syncStatus.syncInProgress = true;

    try {
      const data = await this.exportData();
      const content = JSON.stringify(data, null, 2);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.config.webdavUsername && this.config.webdavPassword) {
        const auth = Buffer.from(
          `${this.config.webdavUsername}:${this.config.webdavPassword}`
        ).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }

      const url = `${this.config.webdavUrl}/code-agent-backup.json`;

      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: content,
      });

      if (!response.ok) {
        throw new Error(`WebDAV upload failed: ${response.statusText}`);
      }

      this.syncStatus.lastSyncAt = Date.now();
      this.syncStatus.lastSyncSuccess = true;
      this.syncStatus.pendingChanges = 0;
      this.syncStatus.error = undefined;

      return true;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'WebDAV sync failed';
      this.syncStatus.lastSyncSuccess = false;
      this.syncStatus.error = errorMessage;
      throw error;
    } finally {
      this.syncStatus.syncInProgress = false;
    }
  }

  /**
   * 从 WebDAV 恢复
   */
  async restoreFromWebDAV(): Promise<ExportData | null> {
    if (!this.config.webdavUrl) {
      throw new Error('WebDAV URL not configured');
    }

    const headers: Record<string, string> = {};

    if (this.config.webdavUsername && this.config.webdavPassword) {
      const auth = Buffer.from(
        `${this.config.webdavUsername}:${this.config.webdavPassword}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }

    const url = `${this.config.webdavUrl}/code-agent-backup.json`;

    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`WebDAV download failed: ${response.statusText}`);
    }

    const content = await response.text();
    return JSON.parse(content);
  }

  // --------------------------------------------------------------------------
  // Auto Sync
  // --------------------------------------------------------------------------

  private startAutoSync(): void {
    this.syncTimer = setInterval(async () => {
      if (this.syncStatus.pendingChanges > 0 && !this.syncStatus.syncInProgress) {
        try {
          await this.sync();
        } catch (error) {
          console.error('Auto sync failed:', error);
        }
      }
    }, this.config.syncInterval);
  }

  /**
   * 通用同步方法
   */
  async sync(): Promise<boolean> {
    switch (this.config.provider) {
      case 'github-gist':
        return this.syncToGist();
      case 'webdav':
        return this.syncToWebDAV();
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  /**
   * 通用恢复方法
   */
  async restore(): Promise<ExportData | null> {
    switch (this.config.provider) {
      case 'github-gist':
        return this.restoreFromGist();
      case 'webdav':
        return this.restoreFromWebDAV();
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  /**
   * 标记有待同步的变更
   */
  markPendingChange(): void {
    this.syncStatus.pendingChanges++;
  }

  /**
   * 停止服务
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let cloudStorageInstance: CloudStorageService | null = null;

export function getCloudStorage(): CloudStorageService {
  if (!cloudStorageInstance) {
    cloudStorageInstance = new CloudStorageService();
  }
  return cloudStorageInstance;
}
