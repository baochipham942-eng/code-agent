#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CHECKED_BROWSER_NAMES = new Set(['chromium', 'chromium-headless-shell', 'ffmpeg']);
const CHROME_CHANNELS = new Set(['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge']);

function readOption(args, name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

export function parseBrowserRuntimeArgs(args = []) {
  return {
    browser: readOption(args, '--browser') ?? 'chromium',
    channel: readOption(args, '--channel'),
    config: readOption(args, '--config'),
    help: hasFlag(args, '--help') || hasFlag(args, '-h'),
    json: hasFlag(args, '--json'),
    requireSystemChrome: hasFlag(args, '--require-system-chrome'),
  };
}

function safeStat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readPackage(cwd, packageName) {
  const packageJsonPath = path.join(cwd, 'node_modules', ...packageName.split('/'), 'package.json');
  const packageJson = safeReadJson(packageJsonPath);
  return {
    name: packageName,
    path: packageJsonPath,
    exists: Boolean(packageJson),
    version: typeof packageJson?.version === 'string' ? packageJson.version : null,
  };
}

function inspectNodeModules(cwd) {
  const nodeModulesPath = path.join(cwd, 'node_modules');
  const stat = safeStat(nodeModulesPath);
  if (!stat) {
    return {
      path: nodeModulesPath,
      exists: false,
      kind: 'missing',
      realpath: null,
    };
  }
  const kind = stat.isSymbolicLink()
    ? 'symlink'
    : stat.isDirectory()
      ? 'directory'
      : 'other';
  return {
    path: nodeModulesPath,
    exists: true,
    kind,
    realpath: kind === 'symlink' ? safeRealpath(nodeModulesPath) : null,
  };
}

export function resolvePlaywrightCacheDir({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === '0') {
    return {
      envValue: configured,
      path: path.join(cwd, 'node_modules', 'playwright-core', '.local-browsers'),
      source: 'package-local',
    };
  }
  if (configured && configured.trim().length > 0) {
    return {
      envValue: configured,
      path: path.resolve(cwd, configured),
      source: 'env',
    };
  }
  if (platform === 'darwin') {
    return {
      envValue: null,
      path: path.join(homedir, 'Library', 'Caches', 'ms-playwright'),
      source: 'default',
    };
  }
  if (platform === 'win32') {
    return {
      envValue: null,
      path: path.join(env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local'), 'ms-playwright'),
      source: 'default',
    };
  }
  return {
    envValue: null,
    path: path.join(env.XDG_CACHE_HOME ?? path.join(homedir, '.cache'), 'ms-playwright'),
    source: 'default',
  };
}

function cacheDirectoryName(browser) {
  return `${browser.name.replaceAll('-', '_')}-${browser.revision}`;
}

function readCheckedBrowsers(cwd, cacheDir, browserMode) {
  const browsersJsonPath = path.join(cwd, 'node_modules', 'playwright-core', 'browsers.json');
  const browsersJson = safeReadJson(browsersJsonPath);
  const installedDirectories = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
    : [];
  const browserEntries = Array.isArray(browsersJson?.browsers) ? browsersJson.browsers : [];
  const checkedNames = browserMode === 'all'
    ? new Set(browserEntries.filter((entry) => entry.installByDefault).map((entry) => entry.name))
    : CHECKED_BROWSER_NAMES;

  return {
    browsersJsonPath,
    browsersJsonExists: Boolean(browsersJson),
    installedDirectories,
    checkedBrowsers: browserEntries
      .filter((entry) => checkedNames.has(entry.name))
      .map((entry) => {
        const directoryName = cacheDirectoryName(entry);
        const directoryPath = path.join(cacheDir, directoryName);
        const directoryExists = fs.existsSync(directoryPath);
        const complete = fs.existsSync(path.join(directoryPath, 'INSTALLATION_COMPLETE'));
        return {
          name: entry.name,
          revision: entry.revision,
          browserVersion: entry.browserVersion ?? null,
          directoryName,
          path: directoryPath,
          installed: complete,
          status: complete ? 'installed' : directoryExists ? 'partial' : 'missing',
        };
      }),
  };
}

function resolveSystemChromeExecutable({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
  const userHome = env.HOME ?? os.homedir();
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(userHome, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  return {
    available: Boolean(executable),
    executable: executable ?? null,
    checked: candidates,
  };
}

function detectConfigChannel(cwd, configPath) {
  if (!configPath) return null;
  const resolvedConfigPath = path.resolve(cwd, configPath);
  let text = '';
  try {
    text = fs.readFileSync(resolvedConfigPath, 'utf8');
  } catch {
    return {
      path: resolvedConfigPath,
      state: 'missing',
      reason: 'config file not readable',
    };
  }
  if (/\bchannel\s*:\s*['"]chrome['"]/.test(text)) {
    return {
      path: resolvedConfigPath,
      state: 'system-chrome',
      reason: 'config sets channel: chrome',
    };
  }
  if (/\bE2E_BROWSER_CHANNEL\b/.test(text)) {
    return {
      path: resolvedConfigPath,
      state: 'env-conditional',
      reason: 'config reads E2E_BROWSER_CHANNEL',
    };
  }
  return {
    path: resolvedConfigPath,
    state: 'bundled-default',
    reason: 'no system Chrome channel found in config',
  };
}

function detectBrowserMode({ cwd, env, platform, channel, config }) {
  const envChannel = env.E2E_BROWSER_CHANNEL ?? null;
  const selectedChannel = channel ?? envChannel;
  const normalizedSelectedChannel = selectedChannel?.toLowerCase();
  const configChannel = detectConfigChannel(cwd, config);
  const systemChrome = resolveSystemChromeExecutable({ env, platform });

  if (normalizedSelectedChannel && CHROME_CHANNELS.has(normalizedSelectedChannel)) {
    return {
      usesSystemChrome: true,
      state: 'system-chrome',
      reason: channel
        ? `--channel=${selectedChannel}`
        : `E2E_BROWSER_CHANNEL=${selectedChannel}`,
      selectedChannel,
      envChannel,
      config: configChannel,
      systemChrome,
    };
  }
  if (configChannel?.state === 'system-chrome') {
    return {
      usesSystemChrome: true,
      state: 'system-chrome',
      reason: configChannel.reason,
      selectedChannel: 'chrome',
      envChannel,
      config: configChannel,
      systemChrome,
    };
  }
  if (configChannel?.state === 'env-conditional') {
    return {
      usesSystemChrome: null,
      state: 'conditional',
      reason: 'config can use E2E_BROWSER_CHANNEL, but it is not set to chrome now',
      selectedChannel: selectedChannel ?? null,
      envChannel,
      config: configChannel,
      systemChrome,
    };
  }
  return {
    usesSystemChrome: false,
    state: 'playwright-bundled',
    reason: 'no system Chrome channel detected; Playwright will use its bundled browser',
    selectedChannel: selectedChannel ?? null,
    envChannel,
    config: configChannel,
    systemChrome,
  };
}

function buildRecommendations(report) {
  const recommendations = [];
  if (!report.nodeModules.exists) {
    recommendations.push('node_modules is missing; in an isolated worktree, link an existing repo node_modules or run npm install before validation.');
  } else if (report.nodeModules.kind === 'symlink') {
    recommendations.push(`node_modules is symlinked to ${report.nodeModules.realpath}; dependency reuse is active for this worktree.`);
  }

  const missingPackages = Object.values(report.packages)
    .filter((pkg) => !pkg.exists)
    .map((pkg) => pkg.name);
  if (missingPackages.length > 0) {
    recommendations.push(`Missing package(s): ${missingPackages.join(', ')}.`);
  }

  const missingBrowsers = report.browserCache.checkedBrowsers
    .filter((browser) => browser.status !== 'installed')
    .map((browser) => browser.directoryName);
  if (report.browserMode.usesSystemChrome === true) {
    recommendations.push('This run is configured for system Chrome; bundled Chromium download should not be required.');
  } else if (missingBrowsers.length > 0) {
    recommendations.push(`Bundled browser cache is missing or partial for: ${missingBrowsers.join(', ')}. Use system Chrome when the spec supports it, or run npx playwright install chromium once for this Playwright version.`);
  }

  if (report.browserMode.usesSystemChrome === true && !report.browserMode.systemChrome.available) {
    recommendations.push('System Chrome mode is selected, but no Chrome executable was found at the common paths; set CHROME_PATH if Chrome is installed elsewhere.');
  }

  if (recommendations.length === 0) {
    recommendations.push('Browser runtime looks ready; no install step is indicated by this diagnostic.');
  }
  return recommendations;
}

export function collectBrowserRuntimeDiagnostics({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  args = [],
  now = new Date(),
} = {}) {
  const parsedArgs = parseBrowserRuntimeArgs(args);
  const nodeModules = inspectNodeModules(cwd);
  const packages = {
    playwright: readPackage(cwd, 'playwright'),
    '@playwright/test': readPackage(cwd, '@playwright/test'),
    'playwright-core': readPackage(cwd, 'playwright-core'),
  };
  const cacheDir = resolvePlaywrightCacheDir({ cwd, env, platform, homedir });
  const browserCache = {
    ...cacheDir,
    exists: fs.existsSync(cacheDir.path),
    ...readCheckedBrowsers(cwd, cacheDir.path, parsedArgs.browser),
  };
  const browserMode = detectBrowserMode({
    cwd,
    env,
    platform,
    channel: parsedArgs.channel,
    config: parsedArgs.config,
  });
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    cwd,
    args: parsedArgs,
    nodeModules,
    packages,
    browserMode,
    browserCache,
  };
  return {
    ...report,
    recommendations: buildRecommendations(report),
  };
}

function formatValue(value) {
  return value === null || value === undefined || value === '' ? '<unset>' : String(value);
}

function formatPackage(pkg) {
  return `${pkg.exists ? pkg.version : 'missing'} (${pkg.path})`;
}

export function formatBrowserRuntimeDiagnostics(report) {
  const lines = [
    'Browser Runtime Diagnostics',
    `- cwd: ${report.cwd}`,
    `- node_modules: ${report.nodeModules.kind}${report.nodeModules.realpath ? ` -> ${report.nodeModules.realpath}` : ''}`,
    '- Playwright packages:',
    `  - playwright: ${formatPackage(report.packages.playwright)}`,
    `  - @playwright/test: ${formatPackage(report.packages['@playwright/test'])}`,
    `  - playwright-core: ${formatPackage(report.packages['playwright-core'])}`,
    '- Browser mode:',
    `  - system Chrome: ${report.browserMode.usesSystemChrome === true ? 'yes' : report.browserMode.usesSystemChrome === null ? 'conditional' : 'no'}`,
    `  - reason: ${report.browserMode.reason}`,
    `  - selected channel: ${formatValue(report.browserMode.selectedChannel)}`,
    `  - Chrome executable: ${report.browserMode.systemChrome.available ? report.browserMode.systemChrome.executable : 'not found'}`,
    '- Playwright browser cache:',
    `  - PLAYWRIGHT_BROWSERS_PATH: ${formatValue(report.browserCache.envValue)}`,
    `  - source: ${report.browserCache.source}`,
    `  - path: ${report.browserCache.path}`,
    `  - exists: ${report.browserCache.exists ? 'yes' : 'no'}`,
    `  - browsers.json: ${report.browserCache.browsersJsonExists ? report.browserCache.browsersJsonPath : 'missing'}`,
    '  - checked browsers:',
    ...report.browserCache.checkedBrowsers.map((browser) => (
      `    - ${browser.directoryName}: ${browser.status}`
    )),
    '  - installed cache dirs:',
    ...(report.browserCache.installedDirectories.length > 0
      ? report.browserCache.installedDirectories.map((entry) => `    - ${entry}`)
      : ['    - <none>']),
    '- Recommendations:',
    ...report.recommendations.map((item) => `  - ${item}`),
    '',
    'This diagnostic is read-only; it does not install browsers or modify node_modules.',
  ];
  return `${lines.join('\n')}\n`;
}

function usage() {
  return `Usage: node scripts/verify-browser-runtime.mjs [--config <path>] [--channel <chrome>] [--browser chromium|all] [--json] [--require-system-chrome]

Prints local Playwright package, browser cache, system Chrome, and node_modules reuse state.
`;
}

function main() {
  const args = process.argv.slice(2);
  const parsedArgs = parseBrowserRuntimeArgs(args);
  if (parsedArgs.help) {
    process.stdout.write(usage());
    return;
  }
  const report = collectBrowserRuntimeDiagnostics({ args });
  process.stdout.write(parsedArgs.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatBrowserRuntimeDiagnostics(report));
  if (parsedArgs.requireSystemChrome && report.browserMode.usesSystemChrome !== true) {
    process.stderr.write('[verify-browser-runtime] system Chrome was required but is not selected.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
