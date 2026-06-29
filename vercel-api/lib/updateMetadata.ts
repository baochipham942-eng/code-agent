import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from './controlPlaneEnvelope.js';

export interface UpdateCheckResponse {
  success: boolean;
  hasUpdate: boolean;
  forceUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  minVersion?: string;
  downloadUrl?: string;
  sha256?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
  channel?: string;
  runtimeAssets?: RuntimeAssetsUpdateMetadata;
  source: 'github_releases';
}

export interface RuntimeAssetsUpdateMetadata {
  /** URL of the signed runtime_assets_manifest control-plane envelope. */
  manifestUrl: string;
  /** SHA-256 hex digest of the signed envelope bytes, not the unsigned payload. */
  manifestSha256: string;
}

interface GitHubReleaseAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
  /** SHA-256 hex digest of the asset bytes (由发布脚本写入 OSS release.json). */
  sha256?: string;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
}

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function getBearerToken(req: ControlPlaneRequestLike): string | null {
  const raw = req.headers?.authorization ?? req.headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const rightParts = right.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function normalizeVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^v/, '');
  return normalized || undefined;
}

function normalizeSha256(value: unknown): string | undefined {
  // value 可能来自未校验的 release.json JSON（asset.sha256 可能是数字等非字符串），
  // 必须先做 typeof 守卫，否则 .trim() 会抛错把 update check 变成 502（与客户端 normalizeUpdateSha256 对齐）。
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function latestVersionOf(...versions: Array<string | undefined>): string | undefined {
  return versions.filter((value): value is string => Boolean(value)).reduce<string | undefined>(
    (winner, candidate) => {
      if (!winner) return candidate;
      return compareVersions(candidate, winner) > 0 ? candidate : winner;
    },
    undefined,
  );
}

function releasePageUrl(repo: string, tagName: string, htmlUrl?: string): string {
  return htmlUrl || `https://github.com/${repo}/releases/tag/${tagName}`;
}

export type NormalizedArch = 'arm64' | 'x64';

// 归一化客户端架构入参。缺省/未知按平台取默认：
// darwin → arm64（历史只发 arm64，保持老客户端向后兼容）；
// win32 → x64（Windows 仅发 x64，且无不带 arch 的历史客户端）。
export function normalizeArch(value: string | null | undefined, platform?: string): NormalizedArch {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'x64' || v === 'x86_64' || v === 'x86-64' || v === 'amd64' || v === 'intel') {
    return 'x64';
  }
  if (v === 'arm64' || v === 'aarch64') {
    return 'arm64';
  }
  return (platform ?? '').toLowerCase() === 'win32' ? 'x64' : 'arm64';
}

function archTokens(arch: NormalizedArch): string[] {
  return arch === 'x64'
    ? ['x64', 'x86_64', 'x86-64', 'amd64', 'intel']
    : ['arm64', 'aarch64'];
}

const ALL_ARCH_TOKENS = ['x64', 'x86_64', 'x86-64', 'amd64', 'intel', 'arm64', 'aarch64'];

function nameHasAnyArchToken(name: string): boolean {
  return ALL_ARCH_TOKENS.some((token) => name.includes(token));
}

function assetMatchesPlatform(name: string, normalizedPlatform: string): boolean {
  if (normalizedPlatform === 'darwin') {
    return name.includes('mac') || name.includes('darwin') || name.endsWith('.dmg');
  }
  if (normalizedPlatform === 'win32') {
    // 'darwin' 含子串 'win'：必须显式排除，否则 darwin 命名的资产会被当成 Windows 资产
    return (name.includes('win') && !name.includes('darwin')) || name.endsWith('.exe') || name.endsWith('.msi');
  }
  if (normalizedPlatform === 'linux') {
    return name.includes('linux') || name.endsWith('.appimage') || name.endsWith('.deb');
  }
  return false;
}

// 下载资产只能是安装包本体；manifest/sha/签名等 sidecar 永不作为 download 重定向目标
// （runtime-assets-manifest-darwin-x64.json 同时含 'win'(darwin) 与 'x64' token，
// 不排除的话会依赖资产数组顺序才不被选中——顺序脆弱性，2026-06-11 复核发现）
function isSidecarAsset(name: string): boolean {
  return /\.(json|sha256|sig|txt|yml|yaml)$/.test(name);
}

function selectAsset(
  assets: GitHubReleaseAsset[] | undefined,
  platform: string,
  arch: NormalizedArch = 'arm64',
): GitHubReleaseAsset | null {
  const normalized = platform.toLowerCase();
  const platformAssets = (assets ?? []).filter((asset) => {
    const name = asset.name?.toLowerCase() ?? '';
    // 必须有 browser_download_url：否则一个 url-less 资产会遮蔽后面有效的同名资产，
    // 导致 check 回退到 release 网页却仍配上该资产的 sha256（download 侧本就要求 url）。
    return Boolean(asset.browser_download_url) && !isSidecarAsset(name) && assetMatchesPlatform(name, normalized);
  });

  // 优先匹配架构标记（x64 / arm64）。manifest 同时含两架构时按 arch 精确命中。
  const tokens = archTokens(arch);
  const archMatch = platformAssets.find((asset) =>
    tokens.some((token) => (asset.name?.toLowerCase() ?? '').includes(token)),
  );
  if (archMatch) return archMatch;

  // 未命中架构标记时：
  // - arm64（默认）可回退到「无任何架构标记」的旧资产（向后兼容历史单 arm64 dmg）；
  // - x64 绝不回退到 arm64 资产，找不到就返回 null → 上游回 404。
  if (arch === 'arm64') {
    return platformAssets.find((asset) => !nameHasAnyArchToken(asset.name?.toLowerCase() ?? '')) ?? null;
  }
  return null;
}

function runtimeManifestScore(assetName: string, platform: string, arch: NormalizedArch): number {
  const name = assetName.toLowerCase();
  const normalizedPlatform = platform.toLowerCase();
  // darwin 下按 arch 排优先级：x64 → darwin-x64 优先；arm64 → darwin-arm64 优先。
  // 末尾保留无 arch 后缀的 darwin / 通用 manifest 作兜底。
  const platformAliases = normalizedPlatform === 'darwin'
    ? (arch === 'x64' ? ['darwin-x64', 'darwin-x86_64', 'darwin'] : ['darwin-arm64', 'darwin'])
    : [normalizedPlatform];

  for (let index = 0; index < platformAliases.length; index += 1) {
    if (name === `runtime-assets-manifest-${platformAliases[index]}.json`) {
      return index;
    }
  }
  if (name === 'runtime-assets-manifest.json') return 50;
  return Number.POSITIVE_INFINITY;
}

function selectRuntimeManifestAsset(
  assets: GitHubReleaseAsset[] | undefined,
  platform: string,
  arch: NormalizedArch,
): GitHubReleaseAsset | null {
  return [...(assets ?? [])]
    .filter((asset) => asset.name && asset.browser_download_url)
    .map((asset) => ({ asset, score: runtimeManifestScore(asset.name!, platform, arch) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.asset.name!.localeCompare(right.asset.name!))
    .at(0)?.asset ?? null;
}

function selectRuntimeManifestShaAsset(
  assets: GitHubReleaseAsset[] | undefined,
  manifestName: string,
): GitHubReleaseAsset | null {
  const names = [
    `${manifestName}.sha256`,
    manifestName.replace(/\.json$/i, '.sha256'),
    'runtime-assets-manifest.sha256',
  ].map((name) => name.toLowerCase());

  return (assets ?? []).find((asset) => {
    const name = asset.name?.toLowerCase();
    return Boolean(name && asset.browser_download_url && names.includes(name));
  }) ?? null;
}

function extractSha256(value: string): string | undefined {
  return normalizeSha256(value.match(/[a-f0-9]{64}/i)?.[0]);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/plain, application/octet-stream, */*',
      'User-Agent': 'Agent-Neo-Update-Control-Plane',
    },
  });
  if (!response.ok) {
    throw new Error(`Runtime assets manifest envelope sha sidecar returned HTTP ${response.status}`);
  }
  return await response.text();
}

export function buildUpdateResponseFromRelease(
  release: GitHubReleaseResponse,
  options: {
    repo: string;
    currentVersion: string;
    platform: string;
    arch?: NormalizedArch;
    channel?: string;
    minVersion?: string;
    latestVersion?: string;
    forceUpdate?: boolean;
    downloadUrl?: string;
    sha256?: string;
    runtimeAssets?: RuntimeAssetsUpdateMetadata;
  },
): UpdateCheckResponse {
  const releaseVersion = normalizeVersion(release.tag_name);
  const policyMinVersion = normalizeVersion(options.minVersion);
  const policyLatestVersion = normalizeVersion(options.latestVersion);
  const minVersionRequired = policyMinVersion
    ? compareVersions(policyMinVersion, options.currentVersion) > 0
    : false;
  const policyHasNewerLatest = policyLatestVersion
    ? compareVersions(policyLatestVersion, options.currentVersion) > 0
    : false;
  const releaseHasUpdate = releaseVersion
    ? compareVersions(releaseVersion, options.currentVersion) > 0
    : false;
  const latestVersion = latestVersionOf(
    releaseVersion,
    policyLatestVersion,
    minVersionRequired ? policyMinVersion : undefined,
  );
  const hasUpdate = releaseHasUpdate || minVersionRequired || policyHasNewerLatest;
  const forceUpdate = Boolean(hasUpdate && (options.forceUpdate === true || minVersionRequired));
  const asset = selectAsset(release.assets, options.platform, options.arch ?? 'arm64');
  const fallbackDownloadUrl = latestVersion
    ? releasePageUrl(
      options.repo,
      releaseVersion === latestVersion ? (release.tag_name ?? `v${latestVersion}`) : `v${latestVersion}`,
      releaseVersion === latestVersion ? release.html_url : undefined,
    )
    : undefined;
  // downloadUrl 与 sha256 必须「同源」——sha256 只能描述实际返回的那个 URL 的字节，
  // 否则会把 sha 贴到不匹配的包上（客户端按 hash 校验必失败）。
  // 历史 bug：曾直接用 fallbackDownloadUrl（release 网页），客户端 downloadFile() 抓到 HTML 装不上。
  // 与 handleDownload(action=download) 的 302 选包逻辑保持同源一致。
  // 每个分支的 sha256 严格只描述本分支返回的那个 URL（同源），杜绝跨源错配：
  //  - env override：URL 与 sha 都来自 env（UPDATE_DOWNLOAD_URL / UPDATE_SHA256 成对）
  //  - 选中资产：URL 与 sha 都来自该资产（游离的 env sha 不属于 OSS 资产，不借用）
  //  - 网页兜底：无可校验产物，不配任何 sha
  let downloadUrl: string | undefined;
  let sha256: string | undefined;
  if (options.downloadUrl) {
    downloadUrl = options.downloadUrl;
    sha256 = normalizeSha256(options.sha256);
  } else if (asset?.browser_download_url) {
    downloadUrl = asset.browser_download_url;
    sha256 = normalizeSha256(asset.sha256);
  } else {
    downloadUrl = fallbackDownloadUrl;
    sha256 = undefined;
  }

  return {
    success: true,
    hasUpdate,
    forceUpdate,
    currentVersion: options.currentVersion,
    ...(latestVersion ? { latestVersion } : {}),
    ...(policyMinVersion ? { minVersion: policyMinVersion } : {}),
    ...(hasUpdate && downloadUrl ? { downloadUrl } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(release.body ? { releaseNotes: release.body } : {}),
    ...(asset?.size ? { fileSize: asset.size } : {}),
    ...(release.published_at ? { publishedAt: release.published_at } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.runtimeAssets ? { runtimeAssets: options.runtimeAssets } : {}),
    source: 'github_releases',
  };
}

function normalizeChannel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() || 'stable';
}

function channelEnvSuffix(channel: string): string {
  return channel.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function readChannelEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  channel: string,
): string | undefined {
  return env[`${key}_${channelEnvSuffix(channel)}`] || env[key];
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  return undefined;
}

export function releasePolicyFromEnv(
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  channel: string;
  minVersion?: string;
  latestVersion?: string;
  forceUpdate?: boolean;
  downloadUrl?: string;
  sha256?: string;
} {
  return {
    channel,
    minVersion: readChannelEnv(env, 'UPDATE_MIN_VERSION', channel),
    latestVersion: readChannelEnv(env, 'UPDATE_LATEST_VERSION', channel),
    forceUpdate: parseBooleanEnv(readChannelEnv(env, 'UPDATE_FORCE_UPDATE', channel)),
    downloadUrl: readChannelEnv(env, 'UPDATE_DOWNLOAD_URL', channel),
    sha256: readChannelEnv(env, 'UPDATE_SHA256', channel),
  };
}

export function runtimeAssetsMetadataFromEnv(
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeAssetsUpdateMetadata | undefined {
  const manifestUrl = readChannelEnv(env, 'RUNTIME_ASSETS_MANIFEST_URL', channel);
  const manifestSha256 = normalizeSha256(readChannelEnv(env, 'RUNTIME_ASSETS_MANIFEST_SHA256', channel));
  if (!manifestUrl || !manifestSha256) {
    return undefined;
  }
  return { manifestUrl, manifestSha256 };
}

export async function runtimeAssetsMetadataFromRelease(
  release: GitHubReleaseResponse,
  platform: string,
  arch: NormalizedArch = 'arm64',
  readText: (url: string) => Promise<string> = fetchText,
): Promise<RuntimeAssetsUpdateMetadata | undefined> {
  const manifestAsset = selectRuntimeManifestAsset(release.assets, platform, arch);
  if (!manifestAsset?.name || !manifestAsset.browser_download_url) {
    return undefined;
  }

  const shaAsset = selectRuntimeManifestShaAsset(release.assets, manifestAsset.name);
  if (!shaAsset?.browser_download_url) {
    return undefined;
  }

  const shaText = await readText(shaAsset.browser_download_url);
  const manifestSha256 = extractSha256(shaText);
  if (!manifestSha256) {
    return undefined;
  }

  return {
    manifestUrl: manifestAsset.browser_download_url,
    manifestSha256,
  };
}

// 发布源：阿里云上海 OSS 上的 release manifest（GitHub release JSON 形状）。
// code-agent 仓库私有后 GitHub Releases 匿名 404，分发改走 OSS（国内无需代理）。
// manifest 形状与 GitHub release 一致，故下游 selectAsset / buildUpdateResponseFromRelease
// / runtimeAssetsMetadataFromRelease 全部无需改动。可用 UPDATE_RELEASE_MANIFEST_URL 覆盖。
const DEFAULT_RELEASE_MANIFEST_URL =
  'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/stable/release.json';

async function fetchLatestRelease(_repo: string): Promise<GitHubReleaseResponse> {
  const manifestUrl = process.env.UPDATE_RELEASE_MANIFEST_URL || DEFAULT_RELEASE_MANIFEST_URL;
  const response = await fetch(manifestUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Agent-Neo-Update-Control-Plane',
    },
  });
  if (!response.ok) {
    throw new Error(`Release manifest returned HTTP ${response.status}`);
  }
  return await response.json() as GitHubReleaseResponse;
}

function sendJson(res: ControlPlaneResponseLike, statusCode: number, value: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(statusCode).json(value);
}

function sendRedirect(res: ControlPlaneResponseLike, location: string): void {
  res.setHeader('Location', location);
  res.status(302).end();
}

async function handleCheck(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  const currentVersion = firstQueryValue(req.query?.version) ?? '0.0.0';
  const platform = firstQueryValue(req.query?.platform) ?? 'darwin';
  const arch = normalizeArch(firstQueryValue(req.query?.arch), platform);
  const channel = normalizeChannel(firstQueryValue(req.query?.channel) ?? process.env.UPDATE_RELEASE_CHANNEL);
  const repo = process.env.UPDATE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'baochipham942-eng/code-agent';
  const release = await fetchLatestRelease(repo);
  let runtimeAssets = runtimeAssetsMetadataFromEnv(channel);
  if (!runtimeAssets) {
    try {
      runtimeAssets = await runtimeAssetsMetadataFromRelease(release, platform, arch);
    } catch (error) {
      console.warn('Failed to derive runtime assets metadata from release assets', error);
    }
  }
  sendJson(res, 200, buildUpdateResponseFromRelease(release, {
    repo,
    currentVersion,
    platform,
    arch,
    ...releasePolicyFromEnv(channel),
    runtimeAssets,
  }));
}

async function handleDownload(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  const platform = firstQueryValue(req.query?.platform) ?? 'darwin';
  const arch = normalizeArch(firstQueryValue(req.query?.arch), platform);
  const channel = normalizeChannel(firstQueryValue(req.query?.channel) ?? process.env.UPDATE_RELEASE_CHANNEL);
  const repo = process.env.UPDATE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'baochipham942-eng/code-agent';
  const policy = releasePolicyFromEnv(channel);

  if (policy.downloadUrl) {
    sendRedirect(res, policy.downloadUrl);
    return;
  }

  const release = await fetchLatestRelease(repo);
  const asset = selectAsset(release.assets, platform, arch);

  if (!asset?.browser_download_url) {
    sendJson(res, 404, {
      success: false,
      error: 'download_asset_not_found',
      message: `No ${platform} (${arch}) download asset was found on the latest GitHub release.`,
      releaseUrl: releasePageUrl(repo, release.tag_name ?? 'latest', release.html_url),
      source: 'github_releases',
    });
    return;
  }

  sendRedirect(res, asset.browser_download_url);
}

function handlePublish(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): void {
  const expectedToken = process.env.CI_PUBLISH_TOKEN;
  if (!expectedToken) {
    sendJson(res, 503, {
      success: false,
      error: 'publish_unconfigured',
      message: 'CI_PUBLISH_TOKEN is not configured for update metadata publishing.',
    });
    return;
  }

  if (getBearerToken(req) !== expectedToken) {
    sendJson(res, 401, {
      success: false,
      error: 'unauthorized',
      message: 'Invalid publish token.',
    });
    return;
  }

  sendJson(res, 202, {
    success: true,
    persisted: false,
    message: 'Update metadata is derived from GitHub Releases; publish payload accepted for CI compatibility.',
  });
}

export async function handleUpdateRequest(
  req: ControlPlaneRequestLike,
  res: ControlPlaneResponseLike,
): Promise<void> {
  try {
    const method = req.method?.toUpperCase() ?? 'GET';
    if (method === 'POST') {
      handlePublish(req, res);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendJson(res, 405, {
        success: false,
        error: 'method_not_allowed',
      });
      return;
    }

    const action = firstQueryValue(req.query?.action) ?? 'check';
    if (action === 'health') {
      sendJson(res, 200, {
        success: true,
        service: 'update',
        source: 'github_releases',
      });
      return;
    }
    if (action === 'download') {
      await handleDownload(req, res);
      return;
    }
    if (action !== 'check') {
      sendJson(res, 400, {
        success: false,
        error: 'unsupported_action',
        message: 'Supported actions are health, check, and download.',
      });
      return;
    }

    await handleCheck(req, res);
  } catch (error) {
    sendJson(res, 502, {
      success: false,
      error: 'update_check_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
