import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error —— 纯 JS 释放门脚本，无类型声明
import { collectBrowserRuntimeDiagnostics, formatBrowserRuntimeDiagnostics, resolvePlaywrightCacheDir } from '../../scripts/verify-browser-runtime.mjs';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeTempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'browser-runtime-diagnostics-'));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(nodeModules: string, packageName: string, version: string) {
  writeJson(path.join(nodeModules, ...packageName.split('/'), 'package.json'), {
    name: packageName,
    version,
  });
}

function writeBrowsersJson(nodeModules: string) {
  writeJson(path.join(nodeModules, 'playwright-core', 'browsers.json'), {
    browsers: [
      { name: 'chromium', revision: '999', installByDefault: true, browserVersion: '120.0.0.0' },
      { name: 'chromium-headless-shell', revision: '999', installByDefault: true, browserVersion: '120.0.0.0' },
      { name: 'ffmpeg', revision: '123', installByDefault: true },
      { name: 'firefox', revision: '777', installByDefault: true },
    ],
  });
}

function writeInstallComplete(cacheRoot: string, directoryName: string) {
  const dir = path.join(cacheRoot, directoryName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
}

describe('browser runtime diagnostics', () => {
  it('reports Playwright package versions, cache status, and system Chrome mode without installing anything', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const nodeModules = path.join(root, 'node_modules');
    const chromePath = path.join(root, 'Google Chrome');
    writePackage(nodeModules, 'playwright', '1.60.0');
    writePackage(nodeModules, '@playwright/test', '1.60.0');
    writePackage(nodeModules, 'playwright-core', '1.60.0');
    writeBrowsersJson(nodeModules);
    writeFileSync(chromePath, '');

    const cacheRoot = path.join(home, 'Library', 'Caches', 'ms-playwright');
    writeInstallComplete(cacheRoot, 'chromium-999');
    writeInstallComplete(cacheRoot, 'ffmpeg-123');

    const report = collectBrowserRuntimeDiagnostics({
      cwd: root,
      env: {
        CHROME_PATH: chromePath,
        E2E_BROWSER_CHANNEL: 'chrome',
        HOME: home,
      },
      homedir: home,
      platform: 'darwin',
      args: ['--config', 'tests/e2e/playwright.e2e.config.ts'],
      now: new Date('2026-06-26T00:00:00.000Z'),
    });

    expect(report.packages.playwright.version).toBe('1.60.0');
    expect(report.packages['@playwright/test'].version).toBe('1.60.0');
    expect(report.browserMode.usesSystemChrome).toBe(true);
    expect(report.browserMode.systemChrome.executable).toBe(chromePath);
    expect(report.browserCache.path).toBe(cacheRoot);
    expect(report.browserCache.checkedBrowsers).toEqual([
      expect.objectContaining({ directoryName: 'chromium-999', status: 'installed' }),
      expect.objectContaining({ directoryName: 'chromium_headless_shell-999', status: 'missing' }),
      expect.objectContaining({ directoryName: 'ffmpeg-123', status: 'installed' }),
    ]);

    const formatted = formatBrowserRuntimeDiagnostics(report);
    expect(formatted).toContain('system Chrome: yes');
    expect(formatted).toContain('chromium_headless_shell-999: missing');
    expect(formatted).toContain('This diagnostic is read-only');
  });

  it('detects symlinked node_modules and package-local browser cache settings', () => {
    const root = makeTempRoot();
    const sharedNodeModules = path.join(root, 'shared-node_modules');
    writePackage(sharedNodeModules, 'playwright', '1.60.0');
    writePackage(sharedNodeModules, '@playwright/test', '1.60.0');
    writePackage(sharedNodeModules, 'playwright-core', '1.60.0');
    writeBrowsersJson(sharedNodeModules);
    symlinkSync(sharedNodeModules, path.join(root, 'node_modules'));

    const report = collectBrowserRuntimeDiagnostics({
      cwd: root,
      env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
      platform: 'darwin',
      args: [],
      now: new Date('2026-06-26T00:00:00.000Z'),
    });

    expect(report.nodeModules.kind).toBe('symlink');
    expect(report.nodeModules.realpath).toBe(realpathSync(sharedNodeModules));
    expect(report.browserCache.source).toBe('package-local');
    expect(report.browserCache.path).toBe(path.join(root, 'node_modules', 'playwright-core', '.local-browsers'));
    expect(report.recommendations.join('\n')).toContain('dependency reuse is active');
  });

  it('keeps package scripts wired to the diagnostic before Playwright e2e runs', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['verify:browser-runtime']).toBe('node scripts/verify-browser-runtime.mjs');
    expect(packageJson.scripts['test:e2e:new-session']).toContain(
      'node scripts/verify-browser-runtime.mjs --config tests/e2e/playwright.e2e.config.ts && playwright test',
    );
    expect(packageJson.scripts['test:e2e:goal-mode']).toContain(
      'node scripts/verify-browser-runtime.mjs --config tests/e2e/playwright.system-chrome.config.ts && playwright test',
    );
    expect(packageJson.scripts['acceptance:design-canvas-browser']).toContain(
      'E2E_BROWSER_CHANNEL=chrome E2E_DISABLE_VIDEO=1 node scripts/verify-browser-runtime.mjs',
    );
  });

  it('resolves explicit Playwright cache directories relative to cwd', () => {
    const root = makeTempRoot();

    expect(resolvePlaywrightCacheDir({
      cwd: root,
      env: { PLAYWRIGHT_BROWSERS_PATH: '.cache/playwright' },
      platform: 'linux',
      homedir: path.join(root, 'home'),
    })).toMatchObject({
      source: 'env',
      path: path.join(root, '.cache', 'playwright'),
    });
  });
});
