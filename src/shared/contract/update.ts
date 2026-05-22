// ============================================================================
// Update Types
// ============================================================================

export interface UpdateInfo {
  hasUpdate: boolean;
  /** 是否强制更新 - true 时弹出不可关闭的更新弹窗 */
  forceUpdate?: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  /**
   * SHA-256 hex digest of the downloadUrl artifact, set by the cloud update API.
   * 当存在时，main 端下完文件必须在本地 hash 校验匹配后才允许执行 installer；
   * 不匹配立刻删除文件并报错。缺失时跳过校验（向后兼容旧 cloud API），但日志要警告。
   * 注意：这是"内容指纹"，server 自身被攻破时可同步推恶意 download_url + 恶意 hash
   * 仍然能通过校验 —— 完整防御需要离线签名（路线图见 docs/audits/...）。
   */
  sha256?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
  runtimeAssets?: RuntimeAssetsUpdateInfo;
}

export interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
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

export type RuntimeAssetStatusState = 'installed' | 'bundledFallback' | 'missing';
export type RuntimeAssetDelivery = 'optional' | 'bundled';

export interface RuntimeAssetModuleStatus {
  name: string;
  path: string;
  exists: boolean;
  source: 'managed' | 'bundled';
}

export interface RuntimeAssetStatusEntry {
  id: string;
  label: string;
  delivery: RuntimeAssetDelivery;
  state: RuntimeAssetStatusState;
  nodeModules: RuntimeAssetModuleStatus[];
  activeRoot?: string;
  installedAt?: string;
  expandedSha256?: string;
}

export interface RuntimeAssetsStatus {
  runtimeBaseDir: string;
  activeManifestPath: string;
  assets: RuntimeAssetStatusEntry[];
  summary: {
    installed: number;
    bundledFallback: number;
    missing: number;
  };
}
