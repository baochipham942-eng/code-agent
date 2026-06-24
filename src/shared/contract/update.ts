// ============================================================================
// Update Types
// ============================================================================

export interface UpdateInfo {
  hasUpdate: boolean;
  /**
   * true 表示这次检查本身失败了（native + cloud 都没拿到结果），而不是"已是最新"。
   * 用来避免把网络/服务失败渲染成绿色"已是最新版本"误导用户。
   */
  checkFailed?: boolean;
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
export type RuntimeAssetRegistryKind = 'node-modules' | 'helper-binary' | 'tool-binary' | 'app-bundle';
export type RuntimeAssetRegistrySource = 'managed' | 'bundled' | 'dev' | 'missing';
export type RuntimeAssetHashKind =
  | 'archiveSha256'
  | 'expandedSha256'
  | 'fileSha256'
  | 'pinnedBinarySha256'
  | 'pinnedArchiveSha256';

export interface RuntimeAssetRegistryEntry {
  id: string;
  label: string;
  kind: RuntimeAssetRegistryKind;
  delivery: RuntimeAssetDelivery;
  state: RuntimeAssetStatusState;
  source: RuntimeAssetRegistrySource;
  path?: string;
  version?: string;
  minShellVersion?: string;
  platform?: string;
  hash?: string;
  hashKind?: RuntimeAssetHashKind;
  required?: boolean;
}

export interface RuntimeAssetModuleStatus {
  name: string;
  path: string;
  exists: boolean;
  source: 'managed' | 'bundled';
}

export interface RuntimeAssetFileStatus {
  name: string;
  path: string;
  exists: boolean;
  executable?: boolean;
  source: RuntimeAssetRegistrySource;
}

export interface RuntimeAssetStatusEntry {
  id: string;
  label: string;
  kind?: RuntimeAssetRegistryKind;
  delivery: RuntimeAssetDelivery;
  state: RuntimeAssetStatusState;
  nodeModules: RuntimeAssetModuleStatus[];
  files?: RuntimeAssetFileStatus[];
  activeRoot?: string;
  installedAt?: string;
  version?: string;
  minShellVersion?: string;
  platform?: string;
  archiveSha256?: string;
  expandedSha256?: string;
  registry?: RuntimeAssetRegistryEntry;
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

export type RendererBundleAttemptOutcome = 'applied' | 'rolled-back' | 'skipped' | 'failed';

export interface RendererBundleActiveStatus {
  version: string;
  contentHash: string;
}

export interface RendererBundleManifestStatus {
  version: string;
  contentHash?: string;
  minShellVersion: string;
  bundleUrl?: string;
  requiredShellCapabilitiesCount: number;
  requiredRuntimeAssetsCount?: number;
  requiredResourcesCount?: number;
  rollbackToBuiltin?: boolean;
  rollbackReason?: string;
}

export interface RendererBundleRolloutAttemptStatus {
  policyUrl: string;
  policyVersion?: string;
  decision:
    | 'use-manifest'
    | 'rollback-to-builtin'
    | 'skip'
    | 'unavailable'
    | 'untrusted';
  rolloutApplied?: boolean;
  rolloutBucket?: number;
  rolloutPercent?: number;
  fallbackReason?: string;
  reason?: string;
  rollbackReason?: string;
  diagnostics?: string[];
  errorMessage?: string;
}

export interface RendererBundleRuntimeAssetPreparationStatus {
  attempted: true;
  installed: Array<{
    assetId: string;
    reusedExistingInstall?: boolean;
  }>;
  skipped: Array<{
    assetId: string;
    reason: string;
  }>;
  errorMessage?: string;
}

export interface RendererBundleLastAttemptStatus {
  checkedAt: string;
  manifestUrl: string;
  currentShellVersion: string;
  outcome: RendererBundleAttemptOutcome;
  reason?: string;
  manifest?: RendererBundleManifestStatus;
  rollout?: RendererBundleRolloutAttemptStatus;
  runtimeAssetPreparation?: RendererBundleRuntimeAssetPreparationStatus;
  diagnostics?: string[];
  missingShellCapabilities?: string[];
  missingRuntimeAssets?: string[];
  missingResources?: string[];
  errorMessage?: string;
}

export interface RendererBundleSourceStatus {
  channel: string;
  manifestUrl?: string;
  manifestUrlOverride?: boolean;
  rolloutPolicyUrl?: string;
  rolloutPolicyUrlOverride?: boolean;
  cohort?: string;
  errorReason?: string;
  errorMessage?: string;
  errorTarget?: string;
}

export interface RendererBundleStatus {
  schemaVersion: 1;
  disabled?: boolean;
  disabledReason?: string;
  source?: RendererBundleSourceStatus;
  activeBundle: RendererBundleActiveStatus | null;
  lastAttempt: RendererBundleLastAttemptStatus | null;
}
