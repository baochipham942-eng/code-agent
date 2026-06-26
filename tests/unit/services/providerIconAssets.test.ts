import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_ICON_ASSET_URI_PREFIX } from '../../../src/shared/modelRuntime';
import {
  readProviderIconAssetManifest,
  resolveProviderIconAsset,
  saveProviderIconAsset,
} from '../../../src/host/services/providerIconAssets';

describe('provider icon assets', () => {
  let tempDir: string;
  const tinyPngIcon = 'data:image/png;base64,aGVsbG8=';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-icon-assets-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stores provider image icons as local assets and resolves them back to data URLs', async () => {
    const saved = await saveProviderIconAsset({
      provider: 'OpenAI Relay',
      dataUrl: tinyPngIcon,
      baseDir: tempDir,
    });

    expect(saved.icon).toMatch(new RegExp(`^${PROVIDER_ICON_ASSET_URI_PREFIX}openai-relay-[a-f0-9]{16}\\.png$`));
    expect(saved.imageBytes).toBe(5);
    expect(saved.contentHash).toHaveLength(64);
    expect(saved).toMatchObject({
      ownership: 'local',
      source: 'local-upload',
      syncState: 'local-only',
    });
    await expect(fs.readFile(saved.path, 'utf8')).resolves.toBe('hello');

    const resolved = await resolveProviderIconAsset(saved.icon, tempDir);
    expect(resolved).toMatchObject({
      icon: saved.icon,
      filename: saved.filename,
      dataUrl: tinyPngIcon,
      imageBytes: 5,
      mimeType: 'image/png',
    });

    const manifest = await readProviderIconAssetManifest(tempDir);
    expect(manifest.assets[saved.icon]).toMatchObject({
      icon: saved.icon,
      filename: saved.filename,
      provider: 'OpenAI Relay',
      mimeType: 'image/png',
      imageBytes: 5,
      contentHash: saved.contentHash,
      ownership: 'local',
      source: 'local-upload',
      syncState: 'local-only',
    });
    expect(manifest.assets[saved.icon]?.createdAt).toEqual(expect.any(Number));
    expect(manifest.assets[saved.icon]?.updatedAt).toEqual(expect.any(Number));
  });

  it('keeps stable manifest creation metadata when the same icon is saved again', async () => {
    const first = await saveProviderIconAsset({
      provider: 'OpenAI Relay',
      dataUrl: tinyPngIcon,
      baseDir: tempDir,
    });
    const firstManifest = await readProviderIconAssetManifest(tempDir);
    const firstCreatedAt = firstManifest.assets[first.icon]?.createdAt;

    const second = await saveProviderIconAsset({
      provider: 'OpenAI Relay',
      dataUrl: tinyPngIcon,
      baseDir: tempDir,
    });
    const secondManifest = await readProviderIconAssetManifest(tempDir);

    expect(second.icon).toBe(first.icon);
    expect(secondManifest.assets[first.icon]?.createdAt).toBe(firstCreatedAt);
    expect(secondManifest.assets[first.icon]?.updatedAt).toEqual(expect.any(Number));
    expect(secondManifest.assets[first.icon]).toMatchObject({
      provider: 'OpenAI Relay',
      ownership: 'local',
      source: 'local-upload',
      syncState: 'local-only',
      contentHash: first.contentHash,
    });
  });

  it('records team sync governance metadata without downgrading it on repeated local saves', async () => {
    const syncedAt = Date.now() - 1_000;
    const teamAsset = await saveProviderIconAsset({
      provider: 'Team Relay',
      dataUrl: tinyPngIcon,
      baseDir: tempDir,
      ownership: 'team',
      source: 'cloud-control-plane',
      syncState: 'synced',
      remoteId: 'team-icon-123',
      lastSyncedAt: syncedAt,
    });

    expect(teamAsset).toMatchObject({
      ownership: 'team',
      source: 'cloud-control-plane',
      syncState: 'synced',
      remoteId: 'team-icon-123',
      lastSyncedAt: syncedAt,
    });

    const localRepeat = await saveProviderIconAsset({
      provider: 'Team Relay',
      dataUrl: tinyPngIcon,
      baseDir: tempDir,
    });
    const manifest = await readProviderIconAssetManifest(tempDir);

    expect(localRepeat.icon).toBe(teamAsset.icon);
    expect(manifest.assets[teamAsset.icon]).toMatchObject({
      ownership: 'team',
      source: 'cloud-control-plane',
      syncState: 'synced',
      remoteId: 'team-icon-123',
      lastSyncedAt: syncedAt,
    });
  });

  it('treats malformed manifests as empty instead of blocking icon resolution', async () => {
    const manifestPath = path.join(tempDir, 'assets', 'provider-icons', 'manifest.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, '{"version": 0, "assets": []}', 'utf8');

    await expect(readProviderIconAssetManifest(tempDir)).resolves.toEqual({
      version: 1,
      updatedAt: 0,
      assets: {},
    });
  });

  it('reads legacy manifest entries with local governance defaults', async () => {
    const manifestPath = path.join(tempDir, 'assets', 'provider-icons', 'manifest.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const icon = `${PROVIDER_ICON_ASSET_URI_PREFIX}legacy-1234.png`;
    await fs.writeFile(manifestPath, JSON.stringify({
      version: 1,
      updatedAt: 10,
      assets: {
        [icon]: {
          icon,
          filename: 'legacy-1234.png',
          provider: 'Legacy',
          mimeType: 'image/png',
          imageBytes: 5,
          contentHash: 'a'.repeat(64),
          ownership: 'local',
          createdAt: 1,
          updatedAt: 2,
        },
      },
    }), 'utf8');

    const manifest = await readProviderIconAssetManifest(tempDir);

    expect(manifest.assets[icon]).toMatchObject({
      ownership: 'local',
      source: 'local-upload',
      syncState: 'local-only',
    });
  });

  it('rejects unsupported data URLs and invalid asset references', async () => {
    await expect(saveProviderIconAsset({
      provider: 'relay',
      dataUrl: 'data:text/html;base64,PGgxPk5vPC9oMT4=',
      baseDir: tempDir,
    })).rejects.toThrow(/supported data:image/);

    await expect(resolveProviderIconAsset(`${PROVIDER_ICON_ASSET_URI_PREFIX}../secret.png`, tempDir))
      .rejects.toThrow(/Invalid provider icon asset reference/);
  });
});
