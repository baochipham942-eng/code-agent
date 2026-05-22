import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUpdateResponseFromRelease,
  compareVersions,
  handleUpdateRequest,
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

  it('builds update responses from GitHub Releases metadata', () => {
    const response = buildUpdateResponseFromRelease({
      tag_name: 'v0.16.76',
      html_url: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      body: 'notes',
      published_at: '2026-05-17T00:00:00Z',
      assets: [
        { name: 'Agent Neo_0.16.76_aarch64.dmg', size: 123, browser_download_url: 'https://example.com/app.dmg' },
      ],
    }, {
      repo: 'acme/code-agent',
      currentVersion: '0.16.75',
      platform: 'darwin',
    });

    expect(response).toMatchObject({
      success: true,
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
      downloadUrl: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
      releaseNotes: 'notes',
      fileSize: 123,
      publishedAt: '2026-05-17T00:00:00Z',
      source: 'github_releases',
    });
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
    }, 'darwin', async (url) => {
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
      downloadUrl: 'https://github.com/acme/code-agent/releases/tag/v0.16.76',
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
