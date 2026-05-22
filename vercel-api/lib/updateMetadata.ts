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
  manifestUrl: string;
  manifestSha256: string;
}

interface GitHubReleaseAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
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

function normalizeSha256(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
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

function selectAsset(assets: GitHubReleaseAsset[] | undefined, platform: string): GitHubReleaseAsset | null {
  const normalized = platform.toLowerCase();
  for (const asset of assets ?? []) {
    const name = asset.name?.toLowerCase() ?? '';
    if (normalized === 'darwin' && (name.includes('mac') || name.includes('darwin') || name.endsWith('.dmg'))) {
      return asset;
    }
    if (normalized === 'win32' && (name.includes('win') || name.endsWith('.exe') || name.endsWith('.msi'))) {
      return asset;
    }
    if (normalized === 'linux' && (name.includes('linux') || name.endsWith('.appimage') || name.endsWith('.deb'))) {
      return asset;
    }
  }
  return null;
}

function runtimeManifestScore(assetName: string, platform: string): number {
  const name = assetName.toLowerCase();
  const normalizedPlatform = platform.toLowerCase();
  const platformAliases = normalizedPlatform === 'darwin'
    ? ['darwin-arm64', 'darwin']
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
): GitHubReleaseAsset | null {
  return [...(assets ?? [])]
    .filter((asset) => asset.name && asset.browser_download_url)
    .map((asset) => ({ asset, score: runtimeManifestScore(asset.name!, platform) }))
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
    throw new Error(`Runtime assets sha sidecar returned HTTP ${response.status}`);
  }
  return await response.text();
}

export function buildUpdateResponseFromRelease(
  release: GitHubReleaseResponse,
  options: {
    repo: string;
    currentVersion: string;
    platform: string;
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
  const asset = selectAsset(release.assets, options.platform);
  const sha256 = normalizeSha256(options.sha256);
  const fallbackDownloadUrl = latestVersion
    ? releasePageUrl(
      options.repo,
      releaseVersion === latestVersion ? (release.tag_name ?? `v${latestVersion}`) : `v${latestVersion}`,
      releaseVersion === latestVersion ? release.html_url : undefined,
    )
    : undefined;

  return {
    success: true,
    hasUpdate,
    forceUpdate,
    currentVersion: options.currentVersion,
    ...(latestVersion ? { latestVersion } : {}),
    ...(policyMinVersion ? { minVersion: policyMinVersion } : {}),
    ...(hasUpdate && (options.downloadUrl || fallbackDownloadUrl)
      ? { downloadUrl: options.downloadUrl || fallbackDownloadUrl }
      : {}),
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
  readText: (url: string) => Promise<string> = fetchText,
): Promise<RuntimeAssetsUpdateMetadata | undefined> {
  const manifestAsset = selectRuntimeManifestAsset(release.assets, platform);
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

async function fetchLatestRelease(repo: string): Promise<GitHubReleaseResponse> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Agent-Neo-Update-Control-Plane',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases API returned HTTP ${response.status}`);
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
  const channel = normalizeChannel(firstQueryValue(req.query?.channel) ?? process.env.UPDATE_RELEASE_CHANNEL);
  const repo = process.env.UPDATE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'baochipham942-eng/code-agent';
  const release = await fetchLatestRelease(repo);
  let runtimeAssets = runtimeAssetsMetadataFromEnv(channel);
  if (!runtimeAssets) {
    try {
      runtimeAssets = await runtimeAssetsMetadataFromRelease(release, platform);
    } catch (error) {
      console.warn('Failed to derive runtime assets metadata from release assets', error);
    }
  }
  sendJson(res, 200, buildUpdateResponseFromRelease(release, {
    repo,
    currentVersion,
    platform,
    ...releasePolicyFromEnv(channel),
    runtimeAssets,
  }));
}

async function handleDownload(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  const platform = firstQueryValue(req.query?.platform) ?? 'darwin';
  const channel = normalizeChannel(firstQueryValue(req.query?.channel) ?? process.env.UPDATE_RELEASE_CHANNEL);
  const repo = process.env.UPDATE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'baochipham942-eng/code-agent';
  const policy = releasePolicyFromEnv(channel);

  if (policy.downloadUrl) {
    sendRedirect(res, policy.downloadUrl);
    return;
  }

  const release = await fetchLatestRelease(repo);
  const asset = selectAsset(release.assets, platform);

  if (!asset?.browser_download_url) {
    sendJson(res, 404, {
      success: false,
      error: 'download_asset_not_found',
      message: `No ${platform} download asset was found on the latest GitHub release.`,
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
