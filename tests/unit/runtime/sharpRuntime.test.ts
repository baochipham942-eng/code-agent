import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSharp, requireSharp } from '../../../src/host/runtime/sharpRuntime';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-sharp-runtime-'));
  tempRoots.push(root);
  return root;
}

function mkdirp(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function writeFile(targetPath: string, content: string): void {
  mkdirp(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('sharpRuntime', () => {
  it('loads Sharp from an active managed runtime asset', () => {
    const root = makeTempRoot();
    const userDataPath = path.join(root, 'user-data');
    const managedRoot = path.join(userDataPath, 'runtime', 'sharp-image-runtime', 'hash');
    writeFile(path.join(managedRoot, 'node_modules', 'sharp', 'index.js'), `
      function sharp(input) {
        return { input, metadata: async () => ({ width: 32, height: 16 }) };
      }
      sharp.kernel = { lanczos3: 'managed-lanczos3' };
      module.exports = sharp;
    `);
    writeFile(path.join(managedRoot, 'node_modules', 'sharp', 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFile(path.join(userDataPath, 'runtime', 'active.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'sharp-image-runtime': {
          assetId: 'sharp-image-runtime',
          root: managedRoot,
          expandedSha256: 'hash',
          archiveSha256: 'a'.repeat(64),
          archiveFile: '/tmp/sharp.tar.gz',
          groups: ['node_modules/sharp'],
          nodeModules: ['sharp'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
      },
    }));

    const options = {
      env: {},
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      userDataPath,
      allowBareModule: false,
    };
    const loaded = loadSharp(options);
    const sharp = requireSharp(options);

    expect(loaded.ok).toBe(true);
    expect(loaded.sharp?.kernel.lanczos3).toBe('managed-lanczos3');
    expect(sharp('image.png')).toMatchObject({ input: 'image.png' });
  });

  it('reports a missing package when no managed or bundled module exists', () => {
    const result = loadSharp({
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: makeTempRoot() },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      userDataPath: makeTempRoot(),
      allowBareModule: false,
    });

    expect(result.ok).toBe(false);
    expect(result.missingPackage).toBe(true);
  });
});
