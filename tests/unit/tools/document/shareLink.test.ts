import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configService = vi.hoisted(() => ({
  token: 'upload-token',
  baseUrl: 'https://share.test',
  getServiceApiKey: vi.fn((): string | undefined => configService.token || undefined),
  getSettings: vi.fn(() => ({ shareService: { baseUrl: configService.baseUrl } })),
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => configService,
}));

import {
  createShareLink,
  getShareLink,
  pushLatestToShareLink,
  revokeShareLink,
  updateShareLinkTtl,
} from '../../../../src/host/tools/document/shareLink';
import { loadMeta, publishVersion } from '../../../../src/host/tools/document/snapshotManager';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('document share links', () => {
  let workDir: string;
  let filePath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'share-link-'));
    filePath = join(workDir, '客户报告.md');
    await writeFile(filePath, 'version one');
    configService.token = 'upload-token';
    configService.baseUrl = 'https://share.test';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  async function create(): Promise<void> {
    publishVersion(filePath);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      token: 'share-token',
      url: 'https://share.test/d/share-token',
      version: 1,
      expiresAt: 1_800_000_000_000,
      createdAt: 1_700_000_000_000,
    }, 201));
    await createShareLink(filePath, 604_800);
  }

  it('rejects every write when the upload token is missing', async () => {
    configService.token = '';
    publishVersion(filePath);

    await expect(createShareLink(filePath, 604_800)).rejects.toThrow('Share service token not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a link from the latest published snapshot and writes the returned URL to meta', async () => {
    publishVersion(filePath);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      token: 'server-token',
      url: 'https://share.test/d/server-token',
      version: 1,
      expiresAt: null,
      createdAt: 1_700_000_000_000,
    }, 201));

    const info = await createShareLink(filePath, 0);

    expect(info.share?.url).toBe('https://share.test/d/server-token');
    expect(loadMeta(filePath).share).toMatchObject({
      token: 'server-token',
      url: 'https://share.test/d/server-token',
      pushedVersion: 1,
      ttlSeconds: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://share.test/api/share',
      expect.objectContaining({ method: 'POST', body: expect.any(Uint8Array) }),
    );
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Share-Name']).toContain("UTF-8''");
  });

  it('does not PUT unchanged content, but pushes a later hash and advances the ledger', async () => {
    await create();
    publishVersion(filePath);
    await pushLatestToShareLink(filePath);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getShareLink(filePath).share?.pushedVersion).toBe(2);

    await writeFile(filePath, 'version two');
    publishVersion(filePath);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      token: 'share-token',
      url: 'https://share.test/d/share-token',
      version: 2,
      expiresAt: 1_800_000_000_000,
      updatedAt: 1_700_000_100_000,
    }));
    const info = await pushLatestToShareLink(filePath);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT' });
    expect(info.share?.pushedVersion).toBe(3);
    expect(info.stale).toBe(false);
  });

  it('does not throw when the latest-content push fails and persists lastError', async () => {
    await create();
    await writeFile(filePath, 'version two');
    publishVersion(filePath);
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(pushLatestToShareLink(filePath)).resolves.toMatchObject({ stale: true });
    expect(loadMeta(filePath).share?.lastError).toContain('offline');
  });

  it('revokes once, records revokedAt, and is locally idempotent', async () => {
    await create();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      token: 'share-token',
      state: 'revoked',
      revokedAt: 1_700_000_200_000,
    }));

    const first = await revokeShareLink(filePath);
    const second = await revokeShareLink(filePath);

    expect(first.share?.revokedAt).toBe(1_700_000_200_000);
    expect(second.share?.revokedAt).toBe(1_700_000_200_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('updates TTL with an empty PUT body', async () => {
    await create();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      token: 'share-token',
      url: 'https://share.test/d/share-token',
      version: 1,
      expiresAt: null,
      updatedAt: 1_700_000_300_000,
    }));

    const info = await updateShareLinkTtl(filePath, 0);

    expect(info.share).toMatchObject({ expiresAt: null, ttlSeconds: 0 });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({
        'Content-Length': '0',
        'X-Share-Ttl-Seconds': '0',
      }),
    });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body');
  });

  it('rejects oversized published snapshots before uploading', async () => {
    await writeFile(filePath, Buffer.alloc(26_214_401));
    publishVersion(filePath);

    await expect(createShareLink(filePath, 604_800)).rejects.toThrow('File exceeds 25 MB');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(filePath)).toHaveLength(26_214_401);
  });
});
