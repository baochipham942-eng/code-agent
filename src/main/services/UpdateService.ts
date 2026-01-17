// ============================================================================
// UpdateService - Client-side update check and download management
// ============================================================================

import { app, shell } from 'electron';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
}

export interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateServiceConfig {
  /** Cloud API URL for update checks */
  updateServerUrl: string;
  /** Check interval in milliseconds (default: 1 hour) */
  checkInterval?: number;
  /** Auto download when update available */
  autoDownload?: boolean;
}

type ProgressCallback = (progress: DownloadProgress) => void;
type CompleteCallback = (filePath: string) => void;
type ErrorCallback = (error: Error) => void;

// ----------------------------------------------------------------------------
// UpdateService Class
// ----------------------------------------------------------------------------

export class UpdateService {
  private static instance: UpdateService | null = null;

  private config: UpdateServiceConfig;
  private checkTimer: NodeJS.Timeout | null = null;
  private isDownloading = false;
  private lastCheck: Date | null = null;
  private cachedUpdateInfo: UpdateInfo | null = null;

  // Callbacks
  private onProgress: ProgressCallback | null = null;
  private onComplete: CompleteCallback | null = null;
  private onError: ErrorCallback | null = null;

  private constructor(config: UpdateServiceConfig) {
    this.config = {
      checkInterval: 60 * 60 * 1000, // 1 hour default
      autoDownload: false,
      ...config,
    };
  }

  // ----------------------------------------------------------------------------
  // Singleton
  // ----------------------------------------------------------------------------

  static initialize(config: UpdateServiceConfig): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService(config);
    }
    return UpdateService.instance;
  }

  static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      throw new Error('UpdateService not initialized. Call initialize() first.');
    }
    return UpdateService.instance;
  }

  // ----------------------------------------------------------------------------
  // Public Methods
  // ----------------------------------------------------------------------------

  /**
   * Get current app version from package.json
   */
  getCurrentVersion(): string {
    return app.getVersion();
  }

  /**
   * Get the platform identifier for update API
   */
  getPlatform(): string {
    const platform = process.platform;
    switch (platform) {
      case 'darwin':
        return 'darwin';
      case 'win32':
        return 'win32';
      case 'linux':
        return 'linux';
      default:
        return platform;
    }
  }

  /**
   * Check for updates from the cloud API
   */
  async checkForUpdates(): Promise<UpdateInfo> {
    const currentVersion = this.getCurrentVersion();
    const platform = this.getPlatform();

    console.log(`[UpdateService] Checking for updates... Current: ${currentVersion}, Platform: ${platform}`);

    try {
      const url = `${this.config.updateServerUrl}/api/update?action=check&version=${currentVersion}&platform=${platform}`;
      const response = await this.httpGet(url);
      const data = JSON.parse(response);

      const updateInfo: UpdateInfo = {
        hasUpdate: data.hasUpdate || false,
        currentVersion,
        latestVersion: data.latestVersion,
        downloadUrl: data.downloadUrl,
        releaseNotes: data.releaseNotes,
        fileSize: data.fileSize,
        publishedAt: data.publishedAt,
      };

      this.lastCheck = new Date();
      this.cachedUpdateInfo = updateInfo;

      console.log(`[UpdateService] Update check result:`, updateInfo.hasUpdate ? `New version ${updateInfo.latestVersion} available` : 'Already up to date');

      // Auto-download if enabled
      if (updateInfo.hasUpdate && this.config.autoDownload && updateInfo.downloadUrl) {
        this.downloadUpdate(updateInfo.downloadUrl);
      }

      return updateInfo;
    } catch (error) {
      console.error('[UpdateService] Failed to check for updates:', error);
      throw error;
    }
  }

  /**
   * Get cached update info without making a request
   */
  getCachedUpdateInfo(): UpdateInfo | null {
    return this.cachedUpdateInfo;
  }

  /**
   * Download the update file
   */
  async downloadUpdate(downloadUrl: string): Promise<string> {
    if (this.isDownloading) {
      throw new Error('Download already in progress');
    }

    this.isDownloading = true;
    console.log(`[UpdateService] Starting download: ${downloadUrl}`);

    try {
      const downloadsPath = app.getPath('downloads');
      const fileName = path.basename(new URL(downloadUrl).pathname);
      const filePath = path.join(downloadsPath, fileName);

      await this.downloadFile(downloadUrl, filePath);

      console.log(`[UpdateService] Download complete: ${filePath}`);
      this.isDownloading = false;

      if (this.onComplete) {
        this.onComplete(filePath);
      }

      return filePath;
    } catch (error) {
      this.isDownloading = false;
      if (this.onError) {
        this.onError(error as Error);
      }
      throw error;
    }
  }

  /**
   * Open the downloaded file (installer) using the default system handler
   */
  async openDownloadedFile(filePath: string): Promise<void> {
    console.log(`[UpdateService] Opening file: ${filePath}`);
    await shell.openPath(filePath);
  }

  /**
   * Open the download URL in the default browser
   */
  async openDownloadUrl(url: string): Promise<void> {
    console.log(`[UpdateService] Opening URL in browser: ${url}`);
    await shell.openExternal(url);
  }

  /**
   * Start automatic update checking
   */
  startAutoCheck(): void {
    if (this.checkTimer) {
      return; // Already running
    }

    console.log(`[UpdateService] Starting auto-check with interval: ${this.config.checkInterval}ms`);

    // Check immediately
    this.checkForUpdates().catch(console.error);

    // Then check periodically
    this.checkTimer = setInterval(() => {
      this.checkForUpdates().catch(console.error);
    }, this.config.checkInterval);
  }

  /**
   * Stop automatic update checking
   */
  stopAutoCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      console.log('[UpdateService] Auto-check stopped');
    }
  }

  /**
   * Set progress callback for download
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  /**
   * Set completion callback for download
   */
  setCompleteCallback(callback: CompleteCallback): void {
    this.onComplete = callback;
  }

  /**
   * Set error callback
   */
  setErrorCallback(callback: ErrorCallback): void {
    this.onError = callback;
  }

  /**
   * Get download status
   */
  isDownloadInProgress(): boolean {
    return this.isDownloading;
  }

  /**
   * Get last check time
   */
  getLastCheckTime(): Date | null {
    return this.lastCheck;
  }

  // ----------------------------------------------------------------------------
  // Private Methods
  // ----------------------------------------------------------------------------

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.httpGet(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);

      const startTime = Date.now();
      let downloadedBytes = 0;

      protocol.get(url, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);

        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;

          if (this.onProgress && totalBytes > 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const bytesPerSecond = downloadedBytes / elapsed;

            this.onProgress({
              percent: (downloadedBytes / totalBytes) * 100,
              transferred: downloadedBytes,
              total: totalBytes,
              bytesPerSecond,
            });
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          file.close();
          fs.unlink(destPath, () => {}); // Delete incomplete file
          reject(err);
        });

        res.on('error', (err) => {
          file.close();
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }
}

// ----------------------------------------------------------------------------
// Module-level helpers
// ----------------------------------------------------------------------------

let updateServiceInstance: UpdateService | null = null;

export function initUpdateService(config: UpdateServiceConfig): UpdateService {
  updateServiceInstance = UpdateService.initialize(config);
  return updateServiceInstance;
}

export function getUpdateService(): UpdateService {
  if (!updateServiceInstance) {
    throw new Error('UpdateService not initialized. Call initUpdateService() first.');
  }
  return updateServiceInstance;
}

export function isUpdateServiceInitialized(): boolean {
  return updateServiceInstance !== null;
}
