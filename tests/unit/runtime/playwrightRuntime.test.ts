import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlaywright, loadPlaywrightChromium } from '../../../src/main/runtime/playwrightRuntime';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-playwright-runtime-'));
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

describe('playwrightRuntime', () => {
  it('loads Playwright from an active managed runtime asset', async () => {
    const root = makeTempRoot();
    const userDataPath = path.join(root, 'user-data');
    const managedRoot = path.join(userDataPath, 'runtime', 'playwright-browser-runtime', 'hash');
    writeFile(path.join(managedRoot, 'node_modules', 'playwright', 'index.js'), "module.exports = require('playwright-core');\n");
    writeFile(path.join(managedRoot, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFile(path.join(managedRoot, 'node_modules', 'playwright-core', 'index.js'), 'module.exports = { chromium: { source: "managed" } };\n');
    writeFile(path.join(managedRoot, 'node_modules', 'playwright-core', 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFile(path.join(userDataPath, 'runtime', 'active.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'playwright-browser-runtime': {
          assetId: 'playwright-browser-runtime',
          root: managedRoot,
          expandedSha256: 'hash',
          archiveSha256: 'a'.repeat(64),
          archiveFile: '/tmp/playwright.tar.gz',
          groups: ['node_modules/playwright', 'node_modules/playwright-core'],
          nodeModules: ['playwright', 'playwright-core'],
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
    const playwright = await loadPlaywright(options);
    const chromium = await loadPlaywrightChromium(options);

    expect(playwright.ok).toBe(true);
    expect(playwright.module?.chromium).toEqual({ source: 'managed' });
    expect(chromium).toMatchObject({ ok: true, chromium: { source: 'managed' } });
  });

  it('reports a missing package when no managed or bundled module exists', async () => {
    const result = await loadPlaywright({
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
