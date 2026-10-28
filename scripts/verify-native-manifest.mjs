#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_PATH = 'dist/native/manifest.json';
const MANIFEST_KIND = 'agent_neo_native_dep_manifest';
const PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);

const ALLOWLIST = [
  {
    pattern: /^node_modules\/keytar\/.*\.node$/,
    reason: 'keytar remains package-resolved until T6 declares it',
  },
  {
    pattern: /^node_modules\/node-pty\/.*\.node$/,
    reason: 'node-pty prebuilds, including conpty.node and pty.node, remain package-resolved until T6',
  },
  {
    pattern: /^node_modules\/@img\/sharp-[^/]+\/.*\.node$/,
    reason: 'platform sharp packages remain package-resolved until T6 declares them',
  },
  {
    pattern: /^node_modules\/better-sqlite3\/prebuilds\/[^/]+\.node$/,
    reason: 'the single-arch node_modules copy is distinct from the declared dist/native copy until T6',
  },
  {
    pattern: /^scripts\/poppler\//,
    reason: 'Poppler executables and dylibs are closed by its own sidecar-manifest release gate',
  },
  {
    pattern: /(?:^|\/)scripts\/Agent Neo Computer Use(?: Dev)?\.app\//,
    reason: 'CUA app bundles retain their signed app-bundle layout until T6 declares them',
  },
  {
    pattern: /^scripts\/(?:rtk|uv)(?:\.exe)?$/,
    reason: 'RTK and uv sidecars remain separately fetched resources until T6 declares them',
  },
  {
    pattern: /^scripts\/(?:system-audio-capture|voice-aec-io|vision-ocr|vision-tagger)$/,
    reason: 'Swift helper binaries remain build-produced resources until T6 declares them',
  },
  {
    pattern: /^scripts\/.*\.(?:mjs|py|sh|ts)$/,
    reason: 'interpreted source and build scripts are not native helper binaries',
  },
  {
    pattern: /^node_modules\/(?:@rolldown\/|@tailwindcss\/|lightningcss-[^/]+\/|(?:playwright\/node_modules\/)?fsevents\/).*\.node$/,
    reason: 'build and development-only native packages are not Tauri bundle resources',
  },
  {
    pattern: /^node_modules\/onnxruntime-node\/.*\.node$/,
    reason: 'onnxruntime is an optional runtime asset governed by the separate runtime-asset manifest',
  },
];

function parseArgs(argv) {
  let root;
  let platform;
  let closure = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--closure') {
      closure = true;
    } else if (argument === '--root' || argument === '--platform') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === '--root') {
        root = path.resolve(value);
      } else {
        platform = value;
      }
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!root || !platform) {
    throw new Error('usage: verify-native-manifest.mjs --root <resources root> --platform <darwin-arm64|darwin-x64|win32-x64> [--closure]');
  }
  if (!PLATFORMS.has(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }
  return { root, platform, closure };
}

function isAllowlisted(relativePath) {
  return ALLOWLIST.some((entry) => entry.pattern.test(relativePath));
}

function walkFiles(root, platform) {
  const files = [];
  const visited = new Set();

  function walk(absoluteDirectory, relativeDirectory) {
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(absoluteDirectory);
    } catch {
      return;
    }
    if (visited.has(realDirectory)) {
      return;
    }
    visited.add(realDirectory);

    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push({ relativePath, mode: stat.mode });
      }
    }
  }

  walk(root, '');
  return files.filter(({ relativePath, mode }) => (
    relativePath.endsWith('.node')
    || ((mode & 0o111) !== 0 && relativePath.startsWith('scripts/'))
    || (platform === 'win32-x64' && /^scripts\/.*\.(?:bat|cmd|exe)$/i.test(relativePath))
  ));
}

function main() {
  const { root, platform, closure } = parseArgs(process.argv.slice(2));
  const failures = [];
  const fail = (relativePath, rule) => {
    failures.push(`[native-manifest] ${relativePath}: ${rule}`);
  };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
  } catch (error) {
    fail(MANIFEST_PATH, error?.code === 'ENOENT' ? 'required manifest is missing' : `cannot be read as JSON (${error.message})`);
  }

  const declaredPaths = new Set();
  if (manifest) {
    if (manifest.kind !== MANIFEST_KIND) {
      fail(MANIFEST_PATH, `kind must be ${MANIFEST_KIND}`);
    }
    if (manifest.schemaVersion !== 1) {
      fail(MANIFEST_PATH, 'schemaVersion must be 1');
    }
    if (manifest.platform !== platform) {
      fail(MANIFEST_PATH, `platform ${manifest.platform} does not match requested ${platform}`);
    }
    if (!manifest.modules || typeof manifest.modules !== 'object' || Array.isArray(manifest.modules)) {
      fail(MANIFEST_PATH, 'modules must be an object');
    } else {
      for (const [moduleName, moduleEntry] of Object.entries(manifest.modules)) {
        if (!moduleEntry || typeof moduleEntry !== 'object' || Array.isArray(moduleEntry)) {
          fail(`${MANIFEST_PATH}#modules.${moduleName}`, 'module entry must be an object');
          continue;
        }
        for (const field of ['entry', 'native', 'path']) {
          const declaredPath = moduleEntry[field];
          if (declaredPath === undefined) {
            continue;
          }
          const label = `${MANIFEST_PATH}#modules.${moduleName}.${field}`;
          if (typeof declaredPath !== 'string' || declaredPath.length === 0) {
            fail(label, `${field} must be a non-empty string`);
            continue;
          }
          if (declaredPath.includes('\\') || path.posix.isAbsolute(declaredPath) || path.win32.isAbsolute(declaredPath)) {
            fail(label, `${field} must be a relative POSIX path under the resources root`);
            continue;
          }
          const normalizedPath = path.posix.normalize(declaredPath);
          if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
            fail(label, `${field} escapes the resources root`);
            continue;
          }
          declaredPaths.add(normalizedPath);
          if (!fs.existsSync(path.join(root, normalizedPath))) {
            fail(normalizedPath, `declared ${field} path is missing`);
          }
        }
      }
    }
  }

  if (closure) {
    for (const { relativePath } of walkFiles(root, platform)) {
      if (!declaredPaths.has(relativePath) && !isAllowlisted(relativePath)) {
        fail(relativePath, 'closure requires every native file and executable scripts helper to be declared or allowlisted');
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[native-manifest] verified ${MANIFEST_PATH} for ${platform} (${declaredPaths.size} declared paths${closure ? ', closure' : ''})`);
}

try {
  main();
} catch (error) {
  console.error(`[native-manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
