import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  attachInstallerShas,
  computeAssetSha256,
  isInstallerAsset,
} from '../../../scripts/build-stable-release-json.mjs';

function fakeResponse(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('build-stable-release-json sha256 helpers', () => {
  it('treats only dmg/exe as installer assets', () => {
    expect(isInstallerAsset('Agent-Neo-0.22.2-arm64.dmg')).toBe(true);
    expect(isInstallerAsset('Agent-Neo-0.22.2-win-x64-setup.exe')).toBe(true);
    expect(isInstallerAsset('runtime-assets-manifest-darwin-arm64.json')).toBe(false);
    expect(isInstallerAsset('runtime-assets-manifest-darwin-arm64.sha256')).toBe(false);
  });

  it('computes sha256 of the fetched bytes', async () => {
    const bytes = new TextEncoder().encode('dmg-bytes');
    const expected = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const fetchImpl = vi.fn(async () => fakeResponse(bytes));

    const digest = await computeAssetSha256('https://oss.example/app.dmg', fetchImpl);

    expect(digest).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledWith('https://oss.example/app.dmg');
  });

  it('attaches sha256 only to installer assets and leaves sidecars untouched', async () => {
    const dmgBytes = new TextEncoder().encode('arm64-dmg');
    const exeBytes = new TextEncoder().encode('win-exe');
    const fetchImpl = vi.fn(async (url: string) =>
      fakeResponse(url.endsWith('.exe') ? exeBytes : dmgBytes));

    const assets = [
      { name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' },
      { name: 'runtime-assets-manifest-darwin-arm64.json', browser_download_url: 'https://oss.example/m.json' },
      { name: 'Agent-Neo-0.22.2-win-x64-setup.exe', browser_download_url: 'https://oss.example/setup.exe' },
    ];

    await attachInstallerShas(assets, { enabled: true, fetchImpl, log: { log() {}, warn() {} } });

    expect(assets[0].sha256).toBe(createHash('sha256').update(Buffer.from(dmgBytes)).digest('hex'));
    expect(assets[1].sha256).toBeUndefined(); // sidecar 不算
    expect(assets[2].sha256).toBe(createHash('sha256').update(Buffer.from(exeBytes)).digest('hex'));
    // 只下载两个安装包，不下 sidecar
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not touch assets when disabled (no network)', async () => {
    const fetchImpl = vi.fn();
    const assets = [{ name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' }];

    await attachInstallerShas(assets, { enabled: false, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(assets[0].sha256).toBeUndefined();
  });

  it('omits sha256 (never throws) when an asset download fails — release must not break', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => fakeResponse(new Uint8Array(), false, 503));
    const assets = [{ name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' }];

    await expect(
      attachInstallerShas(assets, { enabled: true, fetchImpl, log: { log() {}, warn } }),
    ).resolves.toBeDefined();

    expect(assets[0].sha256).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
