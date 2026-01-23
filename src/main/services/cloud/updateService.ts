// ============================================================================
// UpdateService - Client-side update check and download management
// ============================================================================

import { app, shell } from 'electron';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../infra/logger';

const logger = createLogger('UpdateService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface UpdateInfo {
  hasUpdate: boolean;
  /** 是否强制更新 - true 时弹出不可关闭的更新弹窗 */
  forceUpdate?: boolean;
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
   * Check for updates from Vercel API (primary) or GitHub Releases API (fallback)
   */
  async checkForUpdates(): Promise<UpdateInfo> {
    const currentVersion = this.getCurrentVersion();
    const platform = this.getPlatform();

    logger.info(` Checking for updates... Current: ${currentVersion}, Platform: ${platform}`);

    try {
      // Try our Vercel API first (primary source)
      const serverUrl = `${this.config.updateServerUrl}/api/update?action=check&version=${currentVersion}&platform=${platform}`;
      logger.info(` Checking Vercel API: ${serverUrl}`);

      try {
        const response = await this.httpGet(serverUrl);
        const data = JSON.parse(response);

        // Check if response is valid (has success field)
        if (data.success) {
          const updateInfo: UpdateInfo = {
            hasUpdate: data.hasUpdate || false,
            forceUpdate: data.forceUpdate || false,
            currentVersion,
            latestVersion: data.latestVersion,
            downloadUrl: data.downloadUrl,
            releaseNotes: data.releaseNotes,
            fileSize: data.fileSize,
            publishedAt: data.publishedAt,
          };

          this.lastCheck = new Date();
          this.cachedUpdateInfo = updateInfo;

          logger.info(` Vercel API result:`, updateInfo.hasUpdate
            ? `New version ${updateInfo.latestVersion} available (forceUpdate: ${updateInfo.forceUpdate})`
            : 'Already up to date');

          // Auto-download if enabled
          if (updateInfo.hasUpdate && this.config.autoDownload && updateInfo.downloadUrl) {
            this.downloadUpdate(updateInfo.downloadUrl);
          }

          return updateInfo;
        }

        // Invalid response, try GitHub
        throw new Error('Invalid Vercel API response');
      } catch (serverError) {
        logger.info('Vercel API failed, trying GitHub...', serverError);
      }

      // Fallback to GitHub Releases API
      const githubUrl = 'https://api.github.com/repos/baochipham942-eng/code-agent/releases/latest';
      logger.info(` Checking GitHub API: ${githubUrl}`);

      try {
        const response = await this.httpGet(githubUrl);
        const data = JSON.parse(response);

        // Check if response has tag_name (valid release)
        if (!data.tag_name) {
          throw new Error('No release found on GitHub');
        }

        // Parse GitHub Releases API response
        const latestVersion = (data.tag_name || '').replace(/^v/, '');
        const hasUpdate = this.compareVersions(latestVersion, currentVersion) > 0;

        // Find the appropriate asset for the platform
        let downloadUrl: string | undefined;
        let fileSize: number | undefined;
        const assets = data.assets || [];

        for (const asset of assets) {
          const name = asset.name.toLowerCase();
          if (platform === 'darwin' && (name.includes('mac') || name.includes('darwin') || name.endsWith('.dmg'))) {
            downloadUrl = asset.browser_download_url;
            fileSize = asset.size;
            break;
          } else if (platform === 'win32' && (name.includes('win') || name.endsWith('.exe') || name.endsWith('.msi'))) {
            downloadUrl = asset.browser_download_url;
            fileSize = asset.size;
            break;
          } else if (platform === 'linux' && (name.includes('linux') || name.endsWith('.AppImage') || name.endsWith('.deb'))) {
            downloadUrl = asset.browser_download_url;
            fileSize = asset.size;
            break;
          }
        }

        const updateInfo: UpdateInfo = {
          hasUpdate,
          currentVersion,
          latestVersion: latestVersion || undefined,
          downloadUrl,
          releaseNotes: data.body,
          fileSize,
          publishedAt: data.published_at,
        };

        this.lastCheck = new Date();
        this.cachedUpdateInfo = updateInfo;

        logger.info(` GitHub API result:`, updateInfo.hasUpdate ? `New version ${updateInfo.latestVersion} available` : 'Already up to date');

        // Auto-download if enabled
        if (updateInfo.hasUpdate && this.config.autoDownload && updateInfo.downloadUrl) {
          this.downloadUpdate(updateInfo.downloadUrl);
        }

        return updateInfo;
      } catch (githubError) {
        logger.info('GitHub API also failed:', githubError);
      }

      // Both failed, return no update available
      logger.info('Both APIs failed, assuming up to date');
      const updateInfo: UpdateInfo = {
        hasUpdate: false,
        currentVersion,
      };
      this.lastCheck = new Date();
      this.cachedUpdateInfo = updateInfo;
      return updateInfo;
    } catch (error) {
      logger.error(' Failed to check for updates:', error);
      throw error;
    }
  }

  /**
   * Compare two version strings (returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal)
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
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
    logger.info(` Starting download: ${downloadUrl}`);

    try {
      const downloadsPath = app.getPath('downloads');
      // 解码 URL 编码的文件名（如 %20 -> 空格）
      const fileName = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
      const filePath = path.join(downloadsPath, fileName);

      await this.downloadFile(downloadUrl, filePath);

      logger.info(` Download complete: ${filePath}`);
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
    logger.info(` Opening file: ${filePath}`);
    await shell.openPath(filePath);
  }

  /**
   * Open the download URL in the default browser
   */
  async openDownloadUrl(url: string): Promise<void> {
    logger.info(` Opening URL in browser: ${url}`);
    await shell.openExternal(url);
  }

  /**
   * Start automatic update checking
   */
  startAutoCheck(): void {
    if (this.checkTimer) {
      return; // Already running
    }

    logger.info(` Starting auto-check with interval: ${this.config.checkInterval}ms`);

    // Check immediately
    this.checkForUpdates().catch((err) => logger.error('Auto-check failed:', err));

    // Then check periodically
    this.checkTimer = setInterval(() => {
      this.checkForUpdates().catch((err) => logger.error('Auto-check failed:', err));
    }, this.config.checkInterval);
  }

  /**
   * Stop automatic update checking
   */
  stopAutoCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      logger.info('Auto-check stopped');
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
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Code-Agent-Updater/1.0',
          'Accept': 'application/json',
        },
      };

      const req = protocol.request(options, (res) => {
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
      });

      req.on('error', reject);
      req.end();
    });
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(destPath);

      const startTime = Date.now();
      let downloadedBytes = 0;

      logger.info(` Downloading from: ${url}`);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Code-Agent-Updater/1.0',
          'Accept': '*/*',
        },
      };

      const req = protocol.request(options, (res) => {
        logger.info(` Response status: ${res.statusCode}`);

        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          logger.info(` Redirecting to: ${redirectUrl}`);
          if (redirectUrl) {
            file.close();
            try { fs.unlinkSync(destPath); } catch {}
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(destPath); } catch {}
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        logger.info(` Total size: ${totalBytes} bytes`);

        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;

          if (this.onProgress && totalBytes > 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const bytesPerSecond = elapsed > 0 ? downloadedBytes / elapsed : 0;

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
          logger.info(` Download finished: ${downloadedBytes} bytes`);
          resolve();
        });

        file.on('error', (err) => {
          logger.error(` File write error:`, err);
          file.close();
          fs.unlink(destPath, () => {}); // Delete incomplete file
          reject(err);
        });

        res.on('error', (err) => {
          logger.error(` Response error:`, err);
          file.close();
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      req.on('error', (err) => {
        logger.error(` Request error:`, err);
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });

      req.end();
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
