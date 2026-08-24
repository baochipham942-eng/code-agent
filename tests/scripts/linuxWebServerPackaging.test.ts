import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tempRoots: string[] = [];

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function writeFixture(root: string, relativePath: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'fixture');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Linux webServer packaging', () => {
  it('packages a Linux x64 service image with all three native runtimes', () => {
    const dockerfile = readRepoFile('packaging/linux-web-server/Dockerfile');
    const nativeSmoke = readRepoFile('scripts/verify-linux-native-runtime.cjs');
    const packageJson = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };

    expect(packageJson.scripts['package:linux-web']).toContain('--platform linux/amd64');
    expect(dockerfile).toContain('FROM node:24-slim');
    expect(dockerfile).toContain('CODE_AGENT_SERVICE_MODE=1');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).not.toContain('CODE_AGENT_TAURI_BOOT_TOKEN');
    expect(dockerfile).toContain('npm run verify:linux-web:native');
    expect(nativeSmoke).toContain("require('better-sqlite3')");
    expect(nativeSmoke).toContain("require('node-pty')");
    expect(nativeSmoke).toContain("require('sharp')");
  });

  it('builds Linux runtime asset manifests from Linux paths without Darwin fallthrough', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-runtime-assets-'));
    tempRoots.push(tempRoot);
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const outputDir = path.join(tempRoot, 'output');
    [
      'node_modules/onnxruntime-node/package.json',
      'node_modules/onnxruntime-node/dist/index.js',
      'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
      'node_modules/onnxruntime-common/package.json',
      'node_modules/onnxruntime-common/dist/cjs/index.js',
      'node_modules/avr-vad/dist/silero_vad_v5.onnx',
      'node_modules/sharp/package.json',
      'node_modules/@img/colour/package.json',
      'node_modules/@img/sharp-linux-x64/package.json',
      'node_modules/@img/sharp-libvips-linux-x64/package.json',
      'node_modules/detect-libc/package.json',
      'node_modules/semver/package.json',
    ].forEach((entry) => writeFixture(runtimeRoot, entry));

    execFileSync(process.execPath, [
      'scripts/build-runtime-assets.mjs',
      '--root', runtimeRoot,
      '--output-dir', outputDir,
      '--platform', 'linux-x64',
      '--app-version', '0.0.0-test',
      '--asset', 'onnxruntime-vad',
      '--asset', 'sharp-image-runtime',
      '--dry-run',
      '--skip-security-scan',
    ], { cwd: repoRoot, stdio: 'pipe' });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8')) as {
      platform: string;
      assets: Array<{ id: string; groups: string[]; nodeModules: string[] }>;
    };
    expect(manifest.platform).toBe('linux-x64');
    expect(manifest.assets.map((asset) => asset.id)).toEqual([
      'onnxruntime-vad',
      'sharp-image-runtime',
    ]);
    expect(manifest.assets.flatMap((asset) => asset.groups)).toEqual(expect.arrayContaining([
      'node_modules/onnxruntime-node/bin/napi-v6/linux/x64',
      'node_modules/@img/sharp-linux-x64',
      'node_modules/@img/sharp-libvips-linux-x64',
    ]));
    expect(manifest.assets.flatMap((asset) => asset.groups).some((entry) => entry.includes('darwin')))
      .toBe(false);
  });
});
