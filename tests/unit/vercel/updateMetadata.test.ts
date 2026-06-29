import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUpdateResponseFromRelease,
  compareVersions,
  handleUpdateRequest,
  normalizeArch,
  runtimeAssetsMetadataFromEnv,
  runtimeAssetsMetadataFromRelease,
} from '../../../vercel-api/lib/updateMetadata';
import type { ControlPlaneResponseLike } from '../../../vercel-api/lib/controlPlaneEnvelope';

function makeResponse(): ControlPlaneResponseLike & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
} {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
    },
    end() {},
  };
}

describe('vercel update metadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.CI_PUBLISH_TOKEN;
    delete process.env.UPDATE_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.UPDATE_RELEASE_CHANNEL;
    delete process.env.UPDATE_MIN_VERSION;
    delete process.env.UPDATE_MIN_VERSION_BETA;
    delete process.env.UPDATE_LATEST_VERSION;
    delete process.env.UPDATE_LATEST_VERSION_BETA;
    delete process.env.UPDATE_FORCE_UPDATE;
    delete process.env.UPDATE_FORCE_UPDATE_BETA;
    delete process.env.UPDATE_DOWNLOAD_URL;
    delete process.env.UPDATE_DOWNLOAD_URL_BETA;
    delete process.env.UPDATE_SHA256;
    delete process.env.UPDATE_SHA256_BETA;
    delete process.env.RUNTIME_ASSETS_MANIFEST_URL;
    delete process.env.RUNTIME_ASSETS_MANIFEST_URL_BETA;
    delete process.env.RUNTIME_ASSETS_MANIFEST_SHA256;
    delete process.env.RUNTIME_ASSETS_MANIFEST_SHA256_BETA;
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.16.75', '0.16.74')).toBe(1);
    expect(compareVersions('v0.16.75', '0.16.75')).toBe(0);
    expect(compareVersions('0.16.9', '0.16.10')).toBe(-1);
  });

  it('points downloadUrl at the matching asset direct link and passes its sha256 through', () => {
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      body: 'notes',
      published_at: '2026-05-17T00:00:00Z',
      assets: [
        {
          name: 'Agent Neo_0.16.76_aarch64.dmg',
          size: 123,
          browser_download_url: 'https://oss.example.com/v0.16.76/app.dmg',
          sha256: 'A'.repeat(64),
        },
      ],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
    });

    // 历史 bug：downloadUrl 曾返回 release 网页 URL（客户端 downloadFile 抓到 HTML 装不上）。
    // 现在必须返回资产直链，并带上发布脚本写入的 sha256。
    expect(response).toMatchObject({
      success: true,
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
      downloadUrl: 'https://oss.example.com/v0.16.76/app.dmg',
      sha256: 'a'.repeat(64),
      releaseNotes: 'notes',
      fileSize: 123,
      publishedAt: '2026-05-17T00:00:00Z',
      source: 'github_releases',
    });
  });

  it('does not pair an env downloadUrl override with a release asset sha256 (MED1)', () => {
    // env override 提供了 URL 但没提供 sha256，资产又恰好带 sha256：
    // sha256 绝不能贴到 env 的 URL 上（否则客户端按资产 hash 校验 env 包必失败）。
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      assets: [
        {
          name: 'Agent-Neo-0.16.76-arm64.dmg',
          browser_download_url: 'https://oss.example.com/v0.16.76/app.dmg',
          sha256: 'a'.repeat(64),
        },
      ],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
      downloadUrl: 'https://cdn.example.com/hotfix.dmg',
    });

    expect(response.downloadUrl).toBe('https://cdn.example.com/hotfix.dmg');
    expect((response as { sha256?: string }).sha256).toBeUndefined();
  });

  it('skips a url-less asset that would shadow a valid one, keeping downloadUrl+sha256 in sync (MED4)', () => {
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      assets: [
        // 同名但无 url 的资产排在前面，不应被选中遮蔽有效资产
        { name: 'Agent-Neo-0.16.76-arm64.dmg', sha256: 'b'.repeat(64) },
        {
          name: 'Agent-Neo-0.16.76-arm64.dmg',
          browser_download_url: 'https://oss.example.com/v0.16.76/app.dmg',
          sha256: 'a'.repeat(64),
        },
      ],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
    });

    expect(response.downloadUrl).toBe('https://oss.example.com/v0.16.76/app.dmg');
    expect((response as { sha256?: string }).sha256).toBe('a'.repeat(64));
  });

  it('does not 502 when an asset sha256 is a non-string (LOW1)', () => {
    expect(() => buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      assets: [
        {
          name: 'Agent-Neo-0.16.76-arm64.dmg',
          browser_download_url: 'https://oss.example.com/v0.16.76/app.dmg',
          // 畸形 manifest：sha256 是数字
          sha256: 123 as unknown as string,
        },
      ],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
    })).not.toThrow();
  });

  it('falls back to the release page only when no matching asset is present', () => {
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      assets: [],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
    });

    expect(response).toMatchObject({
      hasUpdate: true,
      downloadUrl: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
    });
    expect((response as { sha256?: string }).sha256).toBeUndefined();
  });

  it('applies release policy fields to GitHub-derived metadata', () => {
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.75',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.75',
      assets: [],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
      channel: 'stable',
      minVersion: 'v0.16.76',
      forceUpdate: true,
      downloadUrl: 'https://github.com/acme/code-agent/releases/download/v0.16.76/Code.Agent.dmg',
      sha256: 'A'.repeat(64),
    });

    expect(response).toMatchObject({
      success: true,
      hasUpdate: true,
      forceUpdate: true,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
      minVersion: '0.16.76',
      downloadUrl: 'https://github.com/acme/code-agent/releases/download/v0.16.76/Code.Agent.dmg',
      sha256: 'a'.repeat(64),
      channel: 'stable',
      source: 'github_releases',
    });
  });

  it('adds runtime assets metadata when configured', () => {
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      assets: [],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.76',
      platform: 'darwin',
      runtimeAssets: {
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: 'c'.repeat(64),
      },
    });

    expect(response.runtimeAssets).toEqual({
      manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
      manifestSha256: 'c'.repeat(64),
    });
  });

  it('reads channel-specific runtime assets metadata from env', () => {
    process.env.RUNTIME_ASSETS_MANIFEST_URL = 'https://cdn.example.com/stable/manifest.json';
    process.env.RUNTIME_ASSETS_MANIFEST_SHA256 = 'A'.repeat(64);
    process.env.RUNTIME_ASSETS_MANIFEST_URL_BETA = 'https://cdn.example.com/beta/manifest.json';
    process.env.RUNTIME_ASSETS_MANIFEST_SHA256_BETA = 'B'.repeat(64);

    expect(runtimeAssetsMetadataFromEnv('stable')).toEqual({
      manifestUrl: 'https://cdn.example.com/stable/manifest.json',
      manifestSha256: 'a'.repeat(64),
    });
    expect(runtimeAssetsMetadataFromEnv('beta')).toEqual({
      manifestUrl: 'https://cdn.example.com/beta/manifest.json',
      manifestSha256: 'b'.repeat(64),
    });
  });

  it('derives runtime assets metadata from GitHub release assets and sha sidecar', async () => {
    const metadata = await runtimeAssetsMetadataFromRelease({
      tag_name: 'v0.16.79',
      assets: [
        {
          name: 'runtime-assets-manifest-darwin-arm64.json',
          browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.json',
        },
        {
          name: 'runtime-assets-manifest-darwin-arm64.sha256',
          browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.sha256',
        },
      ],
    }, 'darwin', 'arm64', async (url) => {
      expect(url).toBe('https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.sha256');
      return `${'D'.repeat(64)}  runtime-assets-manifest-darwin-arm64.json\n`;
    });

    expect(metadata).toEqual({
      manifestUrl: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.json',
      manifestSha256: 'd'.repeat(64),
    });
  });

  it('adds runtime assets metadata from release assets during update checks', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.16.79',
          html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.79',
          assets: [
            {
              name: 'runtime-assets-manifest-darwin-arm64.json',
              browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.json',
            },
            {
              name: 'runtime-assets-manifest-darwin-arm64.sha256',
              browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.sha256',
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'e'.repeat(64),
      } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'check',
        version: '0.16.79',
        platform: 'darwin',
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      runtimeAssets: {
        manifestUrl: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.json',
        manifestSha256: 'e'.repeat(64),
      },
    });
  });

  it('does not fail update checks when runtime assets sidecar cannot be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.16.79',
          html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.79',
          assets: [
            {
              name: 'runtime-assets-manifest-darwin-arm64.json',
              browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.json',
            },
            {
              name: 'runtime-assets-manifest-darwin-arm64.sha256',
              browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/runtime-assets-manifest-darwin-arm64.sha256',
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => '',
      } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'check',
        version: '0.16.78',
        platform: 'darwin',
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      hasUpdate: true,
      latestVersion: '0.16.79',
    });
    expect((response.body as { runtimeAssets?: unknown }).runtimeAssets).toBeUndefined();
  });

  it('returns health without calling GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = makeResponse();

    await handleUpdateRequest({ method: 'GET', query: { action: 'health' } }, response);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      service: 'update',
      source: 'github_releases',
    });
  });

  it('checks latest GitHub release for update metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.16.76',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
        body: 'notes',
        published_at: '2026-05-17T00:00:00Z',
        assets: [],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'check',
        version: '0.16.75',
        platform: 'darwin',
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      hasUpdate: true,
      latestVersion: '0.16.76',
      // assets 为空 → 回退 release 网页
      downloadUrl: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
    });
  });

  it('check returns the OSS asset direct link + sha256 from the release manifest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.22.2',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.22.2',
        assets: [
          {
            name: 'Agent-Neo-0.22.2-arm64.dmg',
            size: 34_000_000,
            browser_download_url: 'https://oss.example.com/v0.22.2/Agent-Neo-0.22.2-arm64.dmg',
            sha256: 'a'.repeat(64),
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'check', version: '0.22.1', platform: 'darwin', arch: 'arm64' },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      hasUpdate: true,
      latestVersion: '0.22.2',
      downloadUrl: 'https://oss.example.com/v0.22.2/Agent-Neo-0.22.2-arm64.dmg',
      sha256: 'a'.repeat(64),
    });
  });

  it('redirects download requests to the latest matching GitHub release asset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.16.79',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.79',
        assets: [
          {
            name: 'Agent.Neo.app.tar.gz',
            browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/Agent.Neo.app.tar.gz',
          },
          {
            name: 'Agent.Neo_0.16.79_aarch64.dmg',
            browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/Agent.Neo_0.16.79_aarch64.dmg',
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'download',
        platform: 'darwin',
      },
    }, response);

    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(
      'https://github.com/acme/code-agent/releases/download/v0.16.79/Agent.Neo_0.16.79_aarch64.dmg',
    );
  });

  it('uses channel-specific download URL overrides for download redirects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    process.env.UPDATE_DOWNLOAD_URL_BETA = 'https://cdn.example.com/agent-neo-beta.dmg';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'download',
        platform: 'darwin',
        channel: 'beta',
      },
    }, response);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe('https://cdn.example.com/agent-neo-beta.dmg');
  });

  it('returns a clear error when download requests cannot find a matching asset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.16.79',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.79',
        assets: [
          {
            name: 'Agent.Neo.app.tar.gz',
            browser_download_url: 'https://github.com/acme/code-agent/releases/download/v0.16.79/Agent.Neo.app.tar.gz',
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'download',
        platform: 'darwin',
      },
    }, response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: 'download_asset_not_found',
      releaseUrl: 'https://github.com/acme/code-agent/releases/tag/v0.16.79',
    });
  });

  it('applies channel-specific env policy during update checks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.16.75',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.75',
        assets: [],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    process.env.UPDATE_MIN_VERSION_BETA = '0.16.77';
    process.env.UPDATE_FORCE_UPDATE_BETA = 'true';
    process.env.UPDATE_SHA256_BETA = 'B'.repeat(64);
    process.env.RUNTIME_ASSETS_MANIFEST_URL_BETA = 'https://cdn.example.com/runtime-assets/manifest.json';
    process.env.RUNTIME_ASSETS_MANIFEST_SHA256_BETA = 'C'.repeat(64);
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: {
        action: 'check',
        version: '0.16.75',
        platform: 'darwin',
        channel: 'beta',
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      hasUpdate: true,
      forceUpdate: true,
      latestVersion: '0.16.77',
      minVersion: '0.16.77',
      sha256: 'b'.repeat(64),
      channel: 'beta',
      runtimeAssets: {
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: 'c'.repeat(64),
      },
    });
  });

  it('normalizes arch aliases, defaulting unknown/empty to arm64', () => {
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('x86_64')).toBe('x64');
    expect(normalizeArch('intel')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('aarch64')).toBe('arm64');
    expect(normalizeArch(undefined)).toBe('arm64');
    expect(normalizeArch('')).toBe('arm64');
  });

  it('defaults missing arch by platform: win32 → x64, darwin → arm64', () => {
    expect(normalizeArch(undefined, 'win32')).toBe('x64');
    expect(normalizeArch('', 'win32')).toBe('x64');
    expect(normalizeArch('arm64', 'win32')).toBe('arm64'); // 显式入参不被平台默认覆盖
    expect(normalizeArch(undefined, 'darwin')).toBe('arm64');
  });

  it('serves the windows NSIS setup.exe for platform=win32 (arch 显式或缺省都命中)', async () => {
    const manifest = () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.17.0',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.17.0',
        assets: [
          {
            name: 'Agent-Neo-0.17.0-arm64.dmg',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-arm64.dmg',
          },
          {
            name: 'Agent-Neo-0.17.0-win-x64-setup.exe',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-win-x64-setup.exe',
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';

    // win32 + 显式 arch=x64
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(manifest());
    const explicitRes = makeResponse();
    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'win32', arch: 'x64' },
    }, explicitRes);
    expect(explicitRes.statusCode).toBe(302);
    expect(explicitRes.headers.Location).toBe('https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-win-x64-setup.exe');

    // win32 缺省 arch → 平台默认 x64（不会因 arm64 默认而 404）
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(manifest());
    const defaultRes = makeResponse();
    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'win32' },
    }, defaultRes);
    expect(defaultRes.statusCode).toBe(302);
    expect(defaultRes.headers.Location).toBe('https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-win-x64-setup.exe');
  });

  it('selects the arch-matching dmg from a mixed-arch release manifest', async () => {
    const manifest = () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.17.0',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.17.0',
        assets: [
          {
            name: 'Agent-Neo-0.17.0-arm64.dmg',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-arm64.dmg',
          },
          {
            name: 'Agent-Neo-0.17.0-x64.dmg',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-x64.dmg',
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';

    // x64 客户端拿到 x64 包
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(manifest());
    const x64Res = makeResponse();
    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'darwin', arch: 'x64' },
    }, x64Res);
    expect(x64Res.statusCode).toBe(302);
    expect(x64Res.headers.Location).toBe('https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-x64.dmg');

    // 默认（无 arch）客户端拿到 arm64 包
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(manifest());
    const armRes = makeResponse();
    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'darwin' },
    }, armRes);
    expect(armRes.statusCode).toBe(302);
    expect(armRes.headers.Location).toBe('https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-arm64.dmg');
  });

  it('never serves an arm64 dmg to an x64 client (404 when x64 asset absent)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.17.0',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.17.0',
        assets: [
          {
            name: 'Agent-Neo-0.17.0-arm64.dmg',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-arm64.dmg',
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'darwin', arch: 'x64' },
    }, response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({ success: false, error: 'download_asset_not_found' });
  });

  it('never serves sidecar assets (runtime manifest json/sha) as download targets, regardless of asset order', async () => {
    // 对抗性排序：runtime manifest 排在安装包之前。
    // 'runtime-assets-manifest-darwin-x64.json' 同时含 'win'(darwin) 与 'x64' token，
    // 不排除 sidecar 的话 win32/x64 下载会被重定向到一个 JSON。
    const manifest = () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.17.0',
        html_url: 'https://github.com/acme/code-agent/releases/tag/v0.17.0',
        assets: [
          {
            name: 'runtime-assets-manifest-darwin-x64.json',
            browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-x64.json',
          },
          {
            name: 'runtime-assets-manifest-darwin-arm64.json',
            browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-arm64.json',
          },
          {
            name: 'runtime-assets-manifest-darwin-arm64.sha256',
            browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-arm64.sha256',
          },
          {
            name: 'Agent-Neo-0.17.0-arm64.dmg',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-arm64.dmg',
          },
          {
            name: 'Agent-Neo-0.17.0-win-x64-setup.exe',
            browser_download_url: 'https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-win-x64-setup.exe',
          },
        ],
      }),
    } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(manifest());
    const winRes = makeResponse();
    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'win32', arch: 'x64' },
    }, winRes);
    expect(winRes.statusCode).toBe(302);
    expect(winRes.headers.Location).toBe('https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-win-x64-setup.exe');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(manifest());
    const macRes = makeResponse();
    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'download', platform: 'darwin' },
    }, macRes);
    expect(macRes.statusCode).toBe(302);
    expect(macRes.headers.Location).toBe('https://oss.example.com/v0.17.0/Agent-Neo-0.17.0-arm64.dmg');
  });

  it('derives the arch-specific runtime assets manifest during update checks', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.17.0',
          html_url: 'https://github.com/acme/code-agent/releases/tag/v0.17.0',
          assets: [
            {
              name: 'runtime-assets-manifest-darwin-arm64.json',
              browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-arm64.json',
            },
            {
              name: 'runtime-assets-manifest-darwin-arm64.sha256',
              browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-arm64.sha256',
            },
            {
              name: 'runtime-assets-manifest-darwin-x64.json',
              browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-x64.json',
            },
            {
              name: 'runtime-assets-manifest-darwin-x64.sha256',
              browser_download_url: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-x64.sha256',
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'f'.repeat(64),
      } as Response);
    process.env.UPDATE_GITHUB_REPOSITORY = 'acme/code-agent';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'GET',
      query: { action: 'check', version: '0.16.79', platform: 'darwin', arch: 'x64' },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      runtimeAssets: {
        manifestUrl: 'https://oss.example.com/v0.17.0/runtime-assets-manifest-darwin-x64.json',
        manifestSha256: 'f'.repeat(64),
      },
    });
  });

  it('requires a publish token for POST compatibility endpoint', async () => {
    const response = makeResponse();

    await handleUpdateRequest({ method: 'POST', headers: {} }, response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      error: 'publish_unconfigured',
    });
  });

  it('rejects publish requests with an invalid token', async () => {
    process.env.CI_PUBLISH_TOKEN = 'expected-token';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    }, response);

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      error: 'unauthorized',
    });
  });

  it('accepts publish requests with the configured token without persisting metadata', async () => {
    process.env.CI_PUBLISH_TOKEN = 'expected-token';
    const response = makeResponse();

    await handleUpdateRequest({
      method: 'POST',
      headers: { authorization: 'Bearer expected-token' },
    }, response);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      persisted: false,
    });
  });
});
