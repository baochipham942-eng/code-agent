import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from './controlPlaneEnvelope';

export interface UpdateCheckResponse {
  success: boolean;
  hasUpdate: boolean;
  forceUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
  source: 'github_releases';
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

export function buildUpdateResponseFromRelease(
  release: GitHubReleaseResponse,
  options: {
    repo: string;
    currentVersion: string;
    platform: string;
  },
): UpdateCheckResponse {
  const latestVersion = (release.tag_name ?? '').replace(/^v/, '');
  const hasUpdate = latestVersion
    ? compareVersions(latestVersion, options.currentVersion) > 0
    : false;
  const asset = selectAsset(release.assets, options.platform);

  return {
    success: true,
    hasUpdate,
    forceUpdate: false,
    currentVersion: options.currentVersion,
    ...(latestVersion ? { latestVersion } : {}),
    ...(hasUpdate ? { downloadUrl: releasePageUrl(options.repo, release.tag_name ?? `v${latestVersion}`, release.html_url) } : {}),
    ...(release.body ? { releaseNotes: release.body } : {}),
    ...(asset?.size ? { fileSize: asset.size } : {}),
    ...(release.published_at ? { publishedAt: release.published_at } : {}),
    source: 'github_releases',
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

async function handleCheck(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  const currentVersion = firstQueryValue(req.query?.version) ?? '0.0.0';
  const platform = firstQueryValue(req.query?.platform) ?? 'darwin';
  const repo = process.env.UPDATE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'baochipham942-eng/code-agent';
  const release = await fetchLatestRelease(repo);
  sendJson(res, 200, buildUpdateResponseFromRelease(release, {
    repo,
    currentVersion,
    platform,
  }));
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
    if (action !== 'check') {
      sendJson(res, 400, {
        success: false,
        error: 'unsupported_action',
        message: 'Supported actions are health and check.',
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
