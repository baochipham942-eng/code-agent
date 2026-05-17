import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUpdateResponseFromRelease,
  compareVersions,
  handleUpdateRequest,
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
