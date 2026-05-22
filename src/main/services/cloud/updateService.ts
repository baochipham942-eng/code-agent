// ============================================================================
// UpdateService - Client-side update check and download management
// ============================================================================

import { app, shell } from '../../platform';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../infra/logger';

import { Disposable, getServiceRegistry } from '../serviceRegistry';
import { getCloudConfigService, type ReleasePolicy } from './cloudConfigService';
import {
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
} from './controlPlaneTrust';
import {
  getRuntimeAssetsBaseDir,
  installRuntimeAssetFromManifest,
  readActiveRuntimeAssets,
  type RuntimeAssetsManifest,
} from '../../runtime/runtimeAssetInstaller';
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
  /** SHA-256 hex digest of the downloadUrl artifact (M6.a) */
  sha256?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
  runtimeAssets?: RuntimeAssetsUpdateInfo;
}

export interface RuntimeAssetsUpdateAsset {
  id: string;
  archiveBytes?: number;
  expandedSha256?: string;
  installed?: boolean;
}

export interface RuntimeAssetsUpdateInfo {
  hasUpdate: boolean;
  manifestUrl?: string;
  manifestSha256?: string;
  assets?: RuntimeAssetsUpdateAsset[];
}

export interface PrepareRuntimeAssetsResult {
  installed: Array<{
    assetId: string;
    root: string;
    reusedExistingInstall: boolean;
  }>;
  skipped: Array<{
    assetId: string;
    reason: string;
  }>;
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

/**
 * Compare two sha256 hex digests (case-insensitive). Pure function — exposed
 * so unit tests can cover the comparison logic without mocking fs/network.
 * Returns ok=true on match; ok=false with a human-readable reason on mismatch.
 */
export function verifyDigestMatch(
  actual: string,
  expected: string,
): { ok: true } | { ok: false; reason: string } {
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  if (a === e) return { ok: true };
  return { ok: false, reason: `expected ${e}, got ${a}` };
}

export function normalizeUpdateSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function getTruthyField(record: Record<string, unknown>, key: string): boolean {
  return Boolean(record[key]);
}

interface UpdateServerResponse {
  success: boolean;
  hasUpdate: boolean;
  forceUpdate: boolean;
  latestVersion?: string;
  downloadUrl?: string;
  sha256?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
  runtimeAssets?: {
    manifestUrl?: string;
    manifestSha256?: string;
  };
}

function parseUpdateServerResponse(value: unknown): UpdateServerResponse {
  if (!isRecord(value)) {
    return { success: false, hasUpdate: false, forceUpdate: false };
  }

  return {
    success: getTruthyField(value, 'success'),
    hasUpdate: getTruthyField(value, 'hasUpdate'),
    forceUpdate: getTruthyField(value, 'forceUpdate'),
    latestVersion: getStringField(value, 'latestVersion'),
    downloadUrl: getStringField(value, 'downloadUrl'),
    sha256: normalizeUpdateSha256(value.sha256),
    releaseNotes: getStringField(value, 'releaseNotes'),
    fileSize: getNumberField(value, 'fileSize'),
    publishedAt: getStringField(value, 'publishedAt'),
    runtimeAssets: parseRuntimeAssetsUpdateMetadata(value.runtimeAssets),
  };
}

function parseRuntimeAssetsUpdateMetadata(value: unknown): UpdateServerResponse['runtimeAssets'] | undefined {
  if (!isRecord(value)) return undefined;
  const manifestUrl = getStringField(value, 'manifestUrl');
  const manifestSha256 = normalizeUpdateSha256(value.manifestSha256);
  if (!manifestUrl || !manifestSha256) return undefined;
  return { manifestUrl, manifestSha256 };
}

interface GitHubReleaseAsset {
  name: string;
  browserDownloadUrl?: string;
  size?: number;
}

interface GitHubReleaseResponse {
  tagName?: string;
  body?: string;
  publishedAt?: string;
  assets: GitHubReleaseAsset[];
}

function parseGitHubReleaseResponse(value: unknown): GitHubReleaseResponse {
  if (!isRecord(value)) {
    return { assets: [] };
  }

  const rawAssets = value.assets;
  const assets = Array.isArray(rawAssets)
    ? rawAssets
      .filter(isRecord)
      .map((asset): GitHubReleaseAsset | null => {
        const name = getStringField(asset, 'name');
        if (!name) return null;
        return {
          name,
          browserDownloadUrl: getStringField(asset, 'browser_download_url'),
          size: getNumberField(asset, 'size'),
        };
      })
      .filter((asset): asset is GitHubReleaseAsset => asset !== null)
    : [];

  return {
    tagName: getStringField(value, 'tag_name'),
    body: getStringField(value, 'body'),
    publishedAt: getStringField(value, 'published_at'),
    assets,
  };
}

export function resolveExpectedUpdateSha256(
  expectedSha256: string | undefined,
  allowUnsignedDownload = process.env.CODE_AGENT_ALLOW_UNSIGNED_UPDATE_DOWNLOAD === '1',
): { required: true; sha256: string } | { required: false; reason: string } {
  const normalized = normalizeUpdateSha256(expectedSha256);
  if (normalized) {
    return { required: true, sha256: normalized };
  }
  if (allowUnsignedDownload) {
    return {
      required: false,
      reason: 'CODE_AGENT_ALLOW_UNSIGNED_UPDATE_DOWNLOAD is enabled.',
    };
  }
  throw new Error(
    'Cloud update artifact is missing a valid sha256; refusing direct download. ' +
      'Use the native Tauri updater path or publish update metadata with sha256.',
  );
}

export function compareUpdateVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const parts2 = v2.replace(/^v/, '').split('.').map((part) => Number(part) || 0);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export function applyReleasePolicyToUpdateInfo(
  updateInfo: UpdateInfo,
  releasePolicy: ReleasePolicy | undefined,
): UpdateInfo {
  if (!releasePolicy) return updateInfo;

  const currentVersion = updateInfo.currentVersion;
  const policyMinVersion = releasePolicy.minVersion?.replace(/^v/, '');
  const policyLatestVersion = releasePolicy.latestVersion?.replace(/^v/, '');
  const minVersionRequired = policyMinVersion
    ? compareUpdateVersions(policyMinVersion, currentVersion) > 0
    : false;
  const policyHasNewerLatest = policyLatestVersion
    ? compareUpdateVersions(policyLatestVersion, currentVersion) > 0
    : false;
  const policyRequiresUpdate = minVersionRequired || policyHasNewerLatest;
  const hasUpdate = updateInfo.hasUpdate || policyRequiresUpdate;
  const forceUpdate = Boolean(
    updateInfo.forceUpdate
      || minVersionRequired
      || (releasePolicy.forceUpdate === true && hasUpdate),
  );
  const latestVersionCandidates = [
    updateInfo.latestVersion,
    policyLatestVersion,
    minVersionRequired ? policyMinVersion : undefined,
  ].filter((value): value is string => Boolean(value));
  const latestVersion = latestVersionCandidates.reduce<string | undefined>((winner, candidate) => {
    if (!winner) return candidate;
    return compareUpdateVersions(candidate, winner) > 0 ? candidate : winner;
  }, undefined);
  const policySha256 = normalizeUpdateSha256(releasePolicy.sha256);

  return {
    ...updateInfo,
    hasUpdate,
    forceUpdate,
    ...(latestVersion ? { latestVersion } : {}),
    ...(releasePolicy.downloadUrl && policyRequiresUpdate ? { downloadUrl: releasePolicy.downloadUrl } : {}),
    ...(policySha256 ? { sha256: policySha256 } : {}),
  };
}

export function getRuntimeAssetUpdateInfoFromManifest(
  manifest: RuntimeAssetsManifest,
  activeAssets: Awaited<ReturnType<typeof readActiveRuntimeAssets>>,
  metadata: { manifestUrl?: string; manifestSha256?: string },
): RuntimeAssetsUpdateInfo {
  const assets = manifest.assets.map((asset): RuntimeAssetsUpdateAsset => {
    const active = activeAssets?.assets[asset.id];
    const installed = Boolean(active?.expandedSha256 === asset.expandedSha256);
    return {
      id: asset.id,
      ...(asset.archiveBytes ? { archiveBytes: asset.archiveBytes } : {}),
      expandedSha256: asset.expandedSha256,
      installed,
    };
  });

  return {
    hasUpdate: assets.some((asset) => !asset.installed),
    manifestUrl: metadata.manifestUrl,
    manifestSha256: metadata.manifestSha256,
    assets,
  };
}

function validateRuntimeAssetsManifest(value: unknown): RuntimeAssetsManifest {
  if (
    !isRecord(value)
    || value.kind !== 'agent_neo_runtime_assets'
    || typeof value.schemaVersion !== 'number'
    || !Array.isArray(value.assets)
  ) {
    throw new Error('Invalid runtime assets manifest');
  }
  return {
    schemaVersion: value.schemaVersion,
    kind: 'agent_neo_runtime_assets',
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : undefined,
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : undefined,
    platform: typeof value.platform === 'string' ? value.platform : undefined,
    assets: value.assets as RuntimeAssetsManifest['assets'],
  };
}

function verifyRuntimeAssetsManifestEnvelope(value: unknown): RuntimeAssetsManifest {
  const trust = verifyControlPlaneEnvelope<RuntimeAssetsManifest>(value, {
    kind: 'runtime_assets_manifest',
    publicKeys: getControlPlanePublicKeysFromEnv(),
    requireSignature: true,
  });
  if (!trust.trusted || !trust.payload) {
    const codes = trust.diagnostics.map((entry) => entry.code).join(', ') || 'unknown';
    throw new Error(`Runtime assets manifest envelope is not trusted: ${codes}`);
  }
  return validateRuntimeAssetsManifest(trust.payload);
}

function parseTrustedRuntimeAssetsManifestEnvelope(envelopeText: string): RuntimeAssetsManifest {
  return verifyRuntimeAssetsManifestEnvelope(JSON.parse(envelopeText) as unknown);
}

// ----------------------------------------------------------------------------
// UpdateService Class
// ----------------------------------------------------------------------------

export class UpdateService implements Disposable {
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
    const releasePolicy = this.getReleasePolicy();
    const releaseChannel = releasePolicy?.channel ?? 'stable';

    logger.info(` Checking for updates... Current: ${currentVersion}, Platform: ${platform}`);

    try {
      // Try our Vercel API first (primary source)
      const serverUrl = `${this.config.updateServerUrl}/api/update?action=check&version=${currentVersion}&platform=${platform}&channel=${encodeURIComponent(releaseChannel)}`;
      logger.info(` Checking Vercel API: ${serverUrl}`);

      try {
        const response = await this.httpGet(serverUrl);
        const parsed: unknown = JSON.parse(response);
        const data = parseUpdateServerResponse(parsed);

        // Check if response is valid (has success field)
        if (data.success) {
          const updateInfo = this.applyReleasePolicy({
            hasUpdate: data.hasUpdate || false,
            forceUpdate: data.forceUpdate || false,
            currentVersion,
            latestVersion: data.latestVersion,
            downloadUrl: data.downloadUrl,
            sha256: data.sha256,
            releaseNotes: data.releaseNotes,
            fileSize: data.fileSize,
            publishedAt: data.publishedAt,
            runtimeAssets: await this.resolveRuntimeAssetsUpdateInfo(data.runtimeAssets),
          }, releasePolicy);

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
        const parsed: unknown = JSON.parse(response);
        const data = parseGitHubReleaseResponse(parsed);

        // Check if response has tag_name (valid release)
        if (!data.tagName) {
          throw new Error('No release found on GitHub');
        }

        // Parse GitHub Releases API response
        const latestVersion = data.tagName.replace(/^v/, '');
        const hasUpdate = this.compareVersions(latestVersion, currentVersion) > 0;

        // Find the appropriate asset for the platform
        let downloadUrl: string | undefined;
        let fileSize: number | undefined;
        const assets = data.assets;

        for (const asset of assets) {
          const name = asset.name.toLowerCase();
          if (platform === 'darwin' && (name.includes('mac') || name.includes('darwin') || name.endsWith('.dmg'))) {
            downloadUrl = asset.browserDownloadUrl;
            fileSize = asset.size;
            break;
          } else if (platform === 'win32' && (name.includes('win') || name.endsWith('.exe') || name.endsWith('.msi'))) {
            downloadUrl = asset.browserDownloadUrl;
            fileSize = asset.size;
            break;
          } else if (platform === 'linux' && (name.includes('linux') || name.endsWith('.AppImage') || name.endsWith('.deb'))) {
            downloadUrl = asset.browserDownloadUrl;
            fileSize = asset.size;
            break;
          }
        }

        const updateInfo = this.applyReleasePolicy({
          hasUpdate,
          currentVersion,
          latestVersion: latestVersion || undefined,
          downloadUrl,
          releaseNotes: data.body,
          fileSize,
          publishedAt: data.publishedAt,
        }, releasePolicy);

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
      const updateInfo = this.applyReleasePolicy({
        hasUpdate: false,
        currentVersion,
      }, releasePolicy);
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
    return compareUpdateVersions(v1, v2);
  }

  private getReleasePolicy(): ReleasePolicy | undefined {
    try {
      return getCloudConfigService().getReleasePolicy();
    } catch (error) {
      logger.warn('Failed to read release policy from cloud config', { error: String(error) });
      return undefined;
    }
  }

  private applyReleasePolicy(updateInfo: UpdateInfo, releasePolicy: ReleasePolicy | undefined): UpdateInfo {
    return applyReleasePolicyToUpdateInfo(updateInfo, releasePolicy);
  }

  private async resolveRuntimeAssetsUpdateInfo(
    metadata: UpdateServerResponse['runtimeAssets'],
  ): Promise<RuntimeAssetsUpdateInfo | undefined> {
    if (!metadata?.manifestUrl || !metadata.manifestSha256) {
      return undefined;
    }

    try {
      const manifestText = await this.httpGet(metadata.manifestUrl);
      const actualSha256 = createHash('sha256').update(manifestText).digest('hex');
      const verdict = verifyDigestMatch(actualSha256, metadata.manifestSha256);
      if (!verdict.ok) {
        logger.warn(`Runtime assets manifest sha256 mismatch during check: ${verdict.reason}`);
        return {
          hasUpdate: false,
          manifestUrl: metadata.manifestUrl,
          manifestSha256: metadata.manifestSha256,
          assets: [],
        };
      }

      const manifest = parseTrustedRuntimeAssetsManifestEnvelope(manifestText);

      return getRuntimeAssetUpdateInfoFromManifest(
        manifest,
        await readActiveRuntimeAssets(),
        metadata,
      );
    } catch (error) {
      logger.warn('Failed to resolve runtime assets metadata', { error: String(error) });
      return {
        hasUpdate: false,
        manifestUrl: metadata.manifestUrl,
        manifestSha256: metadata.manifestSha256,
        assets: [],
      };
    }
  }

  /**
   * Get cached update info without making a request
   */
  getCachedUpdateInfo(): UpdateInfo | null {
    return this.cachedUpdateInfo;
  }

  async prepareRuntimeAssets(runtimeBaseDir = getRuntimeAssetsBaseDir()): Promise<PrepareRuntimeAssetsResult> {
    const runtimeAssets = this.cachedUpdateInfo?.runtimeAssets;
    if (!runtimeAssets?.manifestUrl || !runtimeAssets.manifestSha256) {
      return { installed: [], skipped: [{ assetId: '*', reason: 'runtime assets metadata unavailable' }] };
    }

    const downloadDir = path.join(runtimeBaseDir, 'downloads');
    fs.mkdirSync(downloadDir, { recursive: true });

    const manifestEnvelopePath = path.join(downloadDir, 'manifest.envelope.json');
    const manifestPath = path.join(downloadDir, 'manifest.json');
    await this.downloadVerifiedFile(
      runtimeAssets.manifestUrl,
      manifestEnvelopePath,
      runtimeAssets.manifestSha256,
      'Runtime assets manifest envelope',
    );

    const manifest = parseTrustedRuntimeAssetsManifestEnvelope(fs.readFileSync(manifestEnvelopePath, 'utf8'));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const installed: PrepareRuntimeAssetsResult['installed'] = [];
    const skipped: PrepareRuntimeAssetsResult['skipped'] = [];

    for (const asset of manifest.assets) {
      const active = await readActiveRuntimeAssets(runtimeBaseDir);
      if (active?.assets[asset.id]?.expandedSha256 === asset.expandedSha256) {
        skipped.push({ assetId: asset.id, reason: 'already installed' });
        continue;
      }

      if (!asset.archiveSha256) {
        throw new Error(`Runtime asset ${asset.id} is missing archiveSha256`);
      }

      const archiveUrl = new URL(asset.archiveFile, runtimeAssets.manifestUrl).toString();
      const archivePath = path.join(downloadDir, path.basename(asset.archiveFile));
      await this.downloadVerifiedFile(archiveUrl, archivePath, asset.archiveSha256, `Runtime asset ${asset.id}`);
      const result = await installRuntimeAssetFromManifest({
        manifestPath,
        assetId: asset.id,
        archivePath,
        runtimeBaseDir,
      });
      installed.push({
        assetId: result.assetId,
        root: result.root,
        reusedExistingInstall: result.reusedExistingInstall,
      });
    }

    const refreshedActive = await readActiveRuntimeAssets(runtimeBaseDir);
    this.cachedUpdateInfo = {
      ...this.cachedUpdateInfo,
      runtimeAssets: getRuntimeAssetUpdateInfoFromManifest(manifest, refreshedActive, runtimeAssets),
    } as UpdateInfo;

    return { installed, skipped };
  }

  /**
   * Download the update file. If the cached UpdateInfo carries a sha256, the
   * downloaded artifact's hash must match — mismatched files are deleted and
   * the call rejects. Missing sha256 rejects by default so renderer-triggered
   * direct downloads cannot bypass the native updater's signed manifest path.
   *
   * Note: sha256 is read from this.cachedUpdateInfo, NOT from the caller. This
   * prevents a compromised renderer/IPC path from supplying its own expected
   * hash. The contract is: cloud → main → main-side state → main-side check.
   */
  async downloadUpdate(downloadUrl: string): Promise<string> {
    if (this.isDownloading) {
      throw new Error('Download already in progress');
    }

    this.isDownloading = true;
    logger.info(` Starting download: ${downloadUrl}`);

    try {
      const expectedSha256 = resolveExpectedUpdateSha256(this.cachedUpdateInfo?.sha256);
      const downloadsPath = app.getPath('downloads');
      // 解码 URL 编码的文件名（如 %20 -> 空格）
      const fileName = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
      const filePath = path.join(downloadsPath, fileName);

      const actualSha256 = await this.downloadFile(downloadUrl, filePath);

      if (expectedSha256.required) {
        const verdict = verifyDigestMatch(actualSha256, expectedSha256.sha256);
        if (!verdict.ok) {
          try { fs.unlinkSync(filePath); } catch { /* best effort cleanup */ }
          throw new Error(
            `Update sha256 mismatch — refusing to install (${verdict.reason}). ` +
              `File at ${filePath} has been deleted. Re-check the cloud update API.`,
          );
        }
        logger.info(` sha256 verified: ${actualSha256.toLowerCase()}`);
      } else {
        logger.warn(
          `Proceeding with unsigned update download override: ${expectedSha256.reason}`,
        );
      }

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
  async dispose(): Promise<void> {
    this.stopAutoCheck();
  }

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
    // URL 解析提到 executor 外，避免畸形 URL throw 时绕过 listener 注册
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return Promise.reject(new TypeError(`Invalid URL: ${url}`, { cause: e }));
    }
    return new Promise((resolve, reject) => {
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

  /**
   * Download a URL to destPath, streaming through a sha256 hasher.
   * Returns the hex digest of the downloaded bytes for caller-side verification.
   */
  private downloadFile(url: string, destPath: string): Promise<string> {
    // URL 解析提到 executor 外；createWriteStream 留在 executor 内但用 try-catch
    // 兜底（早期失败可立即 reject，无需先创建空文件）
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return Promise.reject(new TypeError(`Invalid URL: ${url}`, { cause: e }));
    }
    return new Promise((resolve, reject) => {
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      let file: fs.WriteStream;
      try {
        file = fs.createWriteStream(destPath);
      } catch (e) {
        return reject(e instanceof Error ? e : new Error(String(e)));
      }
      const hasher = createHash('sha256');

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
            try { fs.unlinkSync(destPath); } catch { /* best effort cleanup */ }
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(destPath); } catch { /* best effort cleanup */ }
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        logger.info(` Total size: ${totalBytes} bytes`);

        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          hasher.update(chunk);

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
          const digest = hasher.digest('hex');
          logger.info(` Download finished: ${downloadedBytes} bytes, sha256=${digest}`);
          resolve(digest);
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

  private async downloadVerifiedFile(
    url: string,
    destPath: string,
    expectedSha256: string,
    label: string,
  ): Promise<string> {
    const expected = normalizeUpdateSha256(expectedSha256);
    if (!expected) {
      throw new Error(`${label} is missing a valid sha256`);
    }

    const actual = await this.downloadFile(url, destPath);
    const verdict = verifyDigestMatch(actual, expected);
    if (!verdict.ok) {
      try { fs.unlinkSync(destPath); } catch { /* best effort cleanup */ }
      throw new Error(`${label} sha256 mismatch (${verdict.reason})`);
    }
    return actual.toLowerCase();
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


// Dispose registration (conditional — only if initialized)
try {
  if (isUpdateServiceInitialized()) {
    getServiceRegistry().register('UpdateService', getUpdateService());
  }
} catch { /* not yet initialized */ }
