import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildForArch } from '../../../src/host/runtime/libreOffice/constants';
import { ensureLibreOffice } from '../../../src/host/runtime/libreOffice/ensure';
import { getLibreOfficeCandidates } from '../../../src/host/runtime/libreOffice/lookup';
import { getLibreOfficeState } from '../../../src/host/runtime/libreOffice/state';

const tempRoots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-libreoffice-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('managed LibreOffice runtime', () => {
  it('pins both official macOS builds and selects x86_64 for x64 hosts', () => {
    expect(buildForArch('arm64').bytes).toBe(297798926);
    expect(buildForArch('x86_64').bytes).toBe(308308875);
    expect(buildForArch('arm64').arch).toBe('arm64');
    expect(buildForArch('x64').arch).toBe('x86_64');
  });

  it('uses the mirror after a slow official probe and records the choice', async () => {
    const dataDir = tempRoot();
    const calls: string[] = [];
    const result = await ensureLibreOffice({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => false,
      which: () => null,
      now: () => new Date('2026-10-15T00:00:00.000Z'),
      probe: async (url) => ({ url, ok: true, ttfbMs: url.includes('documentfoundation') ? 1601 : 2 }),
      download: async (_url, destination) => {
        calls.push('download');
        fs.writeFileSync(destination, 'fake dmg');
      },
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(['download']);
    const log = fs.readFileSync(path.join(dataDir, 'runtimes/libreoffice/install.log'), 'utf8');
    expect(log).toContain('chosen source=https://mirrors.ustc.edu.cn/tdf/libreoffice/stable/26.2.6/mac/aarch64/LibreOffice_26.2.6_MacOS_aarch64.dmg');
  });

  it('returns a structured offline error without downloading when both probes fail', async () => {
    const dataDir = tempRoot();
    let downloads = 0;
    const result = await ensureLibreOffice({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => false,
      which: () => null,
      probe: async (url) => ({ url, ok: false, ttfbMs: 3000 }),
      download: async () => { downloads += 1; },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'LIBREOFFICE_RUNTIME_OFFLINE' } });
    expect(downloads).toBe(0);
  });

  it('removes a checksum mismatch and always detaches after an install failure', async () => {
    const dataDir = tempRoot();
    const commands: string[][] = [];
    const result = await ensureLibreOffice({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => false,
      which: () => null,
      probe: async (url) => ({ url, ok: true, ttfbMs: 1 }),
      download: async (_url, destination) => fs.writeFileSync(destination, 'wrong bytes'),
      runCommand: async (file, args) => { commands.push([file, ...args]); },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'LIBREOFFICE_RUNTIME_INSTALL_FAILED' } });
    expect(commands.some(([file]) => file === 'hdiutil')).toBe(false);
    const download = path.join(dataDir, 'runtimes/libreoffice/.LibreOffice_26.2.6_MacOS_aarch64.dmg.download');
    expect(fs.existsSync(download)).toBe(false);

    const validBytes = 'valid fake dmg';
    const arm64Build = buildForArch('arm64');
    const expected = arm64Build.sha256;
    arm64Build.sha256 = crypto.createHash('sha256').update(validBytes).digest('hex');
    const failure = await ensureLibreOffice({
      dataDir: tempRoot(),
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => false,
      which: () => null,
      probe: async (url) => ({ url, ok: true, ttfbMs: 1 }),
      download: async (_url, destination) => fs.writeFileSync(destination, validBytes),
      runCommand: async (file, args) => {
        commands.push([file, ...args]);
        if (file === 'ditto') return;
      },
    });
    arm64Build.sha256 = expected;
    expect(failure).toMatchObject({ ok: false, error: { code: 'LIBREOFFICE_RUNTIME_INSTALL_FAILED' } });
    expect(commands.some(([file, ...args]) => file === 'hdiutil' && args[0] === 'detach')).toBe(true);
  });

  it('writes ready.json last and deduplicates concurrent calls', async () => {
    const dataDir = tempRoot();
    let resolveDownload: (() => void) | undefined;
    const download = async (_url: string, destination: string) => {
      await new Promise<void>((resolve) => { resolveDownload = resolve; });
      fs.writeFileSync(destination, 'not a real dmg');
    };
    const first = ensureLibreOffice({ dataDir, platform: 'darwin', arch: 'arm64', existsSync: () => false, which: () => null, probe: async (url) => ({ url, ok: false, ttfbMs: 3000 }), download });
    const second = ensureLibreOffice({ dataDir, platform: 'darwin', arch: 'arm64', existsSync: () => false, which: () => null, probe: async (url) => ({ url, ok: false, ttfbMs: 3000 }), download });
    expect(second).toBe(first);
    resolveDownload?.();
    await expect(first).resolves.toMatchObject({ ok: false });
    expect(getLibreOfficeState({ dataDir, platform: 'darwin', existsSync: () => false, which: () => null }).phase).toBe('failed');
  });

  it('orders env, managed, search paths, then which', () => {
    const dataDir = tempRoot();
    const envPath = path.join(dataDir, 'explicit-soffice');
    const managedPath = path.join(dataDir, 'runtimes/libreoffice/LibreOffice.app/Contents/MacOS/soffice');
    const existing = new Set([envPath, managedPath, '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/local/bin/libreoffice']);
    const candidates = getLibreOfficeCandidates({
      dataDir,
      env: { LIBREOFFICE_PATH: envPath },
      existsSync: (candidate) => existing.has(candidate),
      which: (binary) => binary === 'soffice' ? '/which/soffice' : null,
    });
    expect(candidates.slice(0, 4)).toEqual([
      envPath,
      managedPath,
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/local/bin/libreoffice',
    ]);
    expect(candidates).toContain('/which/soffice');
  });
});
