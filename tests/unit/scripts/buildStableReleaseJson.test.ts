import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  attachInstallerShas,
  computeAssetSha256,
  isInstallerAsset,
} from '../../../scripts/build-stable-release-json.mjs';

// 真安装包至少 ~1MB，构造一个够大的 buffer 通过体积闸。
function installerBytes(seed: number): Uint8Array {
  const buf = new Uint8Array(1_000_000 + 16);
  buf.fill(seed % 256);
  return buf;
}

function fakeResponse(
  bytes: Uint8Array,
  { ok = true, status = 200, contentType = 'application/octet-stream' }: { ok?: boolean; status?: number; contentType?: string } = {},
): Response {
  return {
    ok,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
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
    const bytes = installerBytes(7);
    const expected = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const fetchImpl = vi.fn(async () => fakeResponse(bytes));

    const digest = await computeAssetSha256('https://oss.example/app.dmg', fetchImpl);

    expect(digest).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledWith('https://oss.example/app.dmg');
  });

  it('rejects an HTML error page even when it returns 200 (MED2)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(installerBytes(1), { contentType: 'text/html; charset=utf-8' }));
    await expect(computeAssetSha256('https://oss.example/oops.dmg', fetchImpl)).rejects.toThrow(/content-type/i);
  });

  it('rejects a too-small body (likely a placeholder, not an installer) (MED2)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(new TextEncoder().encode('nope')));
    await expect(computeAssetSha256('https://oss.example/tiny.dmg', fetchImpl)).rejects.toThrow(/too small/i);
  });

  it('attaches sha256 only to installer assets and leaves sidecars untouched', async () => {
    const dmgBytes = installerBytes(11);
    const exeBytes = installerBytes(22);
    const fetchImpl = vi.fn(async (url: string) =>
      fakeResponse(url.endsWith('.exe') ? exeBytes : dmgBytes));

    const assets = [
      { name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' },
      { name: 'runtime-assets-manifest-darwin-arm64.json', browser_download_url: 'https://oss.example/m.json' },
      { name: 'Agent-Neo-0.22.2-win-x64-setup.exe', browser_download_url: 'https://oss.example/setup.exe' },
    ] as Array<{ name: string; browser_download_url: string; sha256?: string }>;

    await attachInstallerShas(assets, { enabled: true, fetchImpl, log: { log() {}, warn() {} } });

    expect(assets[0].sha256).toBe(createHash('sha256').update(Buffer.from(dmgBytes)).digest('hex'));
    expect(assets[1].sha256).toBeUndefined(); // sidecar 不算
    expect(assets[2].sha256).toBe(createHash('sha256').update(Buffer.from(exeBytes)).digest('hex'));
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 只下载两个安装包，不下 sidecar
  });

  it('retries a transient failure before computing sha256 (MED3)', async () => {
    const bytes = installerBytes(33);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return fakeResponse(new Uint8Array(), { ok: false, status: 503 });
      return fakeResponse(bytes);
    });
    const assets = [{ name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' }] as Array<{ name: string; browser_download_url: string; sha256?: string }>;

    await attachInstallerShas(assets, { enabled: true, fetchImpl, log: { log() {}, warn() {} } });

    expect(assets[0].sha256).toBe(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
    expect(calls).toBe(2);
  });

  it('does not touch assets when disabled (no network)', async () => {
    const fetchImpl = vi.fn();
    const assets = [{ name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' }] as Array<{ name: string; browser_download_url: string; sha256?: string }>;

    await attachInstallerShas(assets, { enabled: false, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(assets[0].sha256).toBeUndefined();
  });

  it('omits sha256 (never throws) after retries are exhausted — release must not break', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => fakeResponse(new Uint8Array(), { ok: false, status: 503 }));
    const assets = [{ name: 'Agent-Neo-0.22.2-arm64.dmg', browser_download_url: 'https://oss.example/app.dmg' }] as Array<{ name: string; browser_download_url: string; sha256?: string }>;

    await expect(
      attachInstallerShas(assets, { enabled: true, fetchImpl, log: { log() {}, warn } }),
    ).resolves.toBeDefined();

    expect(assets[0].sha256).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 重试 3 次后放弃
  });
});
