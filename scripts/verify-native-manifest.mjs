#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_PATH = 'dist/native/manifest.json';
const MANIFEST_KIND = 'agent_neo_native_dep_manifest';
const PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);

// Standing exclusions only: every keytar/node-pty/sharp/sidecar native file that
// ships in a bundle must be declared by the manifest itself (ADR-086 full closure).
const STATIC_ALLOWLIST = [
  {
    pattern: /^node_modules\/better-sqlite3\/prebuilds\/[^/]+\.node$/,
    reason: 'the node_modules prebuilds directory is an npm install artifact; the shipped copy is the declared dist/native assembly',
  },
  {
    pattern: /^scripts\/poppler\//,
    reason: 'Poppler executables and dylibs are closed by its own sidecar-manifest release gate (belt-and-braces: also declared as a helper-dir)',
  },
  {
    pattern: /^scripts\/.*\.(?:bat|cmd|mjs|py|sh|ts)$/,
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

function allowlistFor(platform) {
  return [
    ...STATIC_ALLOWLIST,
    {
      pattern: new RegExp(`^node_modules/node-pty/prebuilds/(?!${platform}/)[^/]+/[^/]+\\.node$`),
      reason: "node-pty's npm tarball carries prebuilds for every platform; only the target platform directory is declared and bundled",
    },
  ];
}

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

function isAllowlisted(relativePath, platform) {
  return allowlistFor(platform).some((entry) => entry.pattern.test(relativePath));
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
  // helper-dir / app-bundle declarations cover every file under their path.
  const declaredDirectoryPaths = new Set();
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
      const validateDeclaredPath = (declaredPath, label, field) => {
        if (typeof declaredPath !== 'string' || declaredPath.length === 0) {
          fail(label, `${field} must be a non-empty string`);
          return;
        }
        if (declaredPath.includes('\\') || path.posix.isAbsolute(declaredPath) || path.win32.isAbsolute(declaredPath)) {
          fail(label, `${field} must be a relative POSIX path under the resources root`);
          return;
        }
        const normalizedPath = path.posix.normalize(declaredPath);
        if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
          fail(label, `${field} escapes the resources root`);
          return;
        }
        declaredPaths.add(normalizedPath);
        if (!fs.existsSync(path.join(root, normalizedPath))) {
          fail(normalizedPath, `declared ${field} path is missing`);
        }
      };
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
          validateDeclaredPath(declaredPath, `${MANIFEST_PATH}#modules.${moduleName}.${field}`, field);
        }
        const natives = moduleEntry.natives;
        if (natives !== undefined) {
          const label = `${MANIFEST_PATH}#modules.${moduleName}.natives`;
          if (!Array.isArray(natives) || natives.length === 0
            || natives.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
            fail(label, 'natives must be a non-empty array of non-empty strings');
          } else {
            natives.forEach((declaredPath) => validateDeclaredPath(declaredPath, label, 'natives'));
          }
        }
        if (moduleEntry.kind === 'helper-dir' || moduleEntry.kind === 'app-bundle') {
          const declaredPath = moduleEntry.path;
          if (typeof declaredPath === 'string' && declaredPath.length > 0) {
            const normalizedPath = path.posix.normalize(declaredPath);
            if (!normalizedPath.startsWith('../')) {
              declaredDirectoryPaths.add(normalizedPath);
            }
          }
        }
      }
    }
  }

  if (closure) {
    const coveredByDeclaredDirectory = (relativePath) => declaredDirectoryPaths.size > 0 && Array.from(declaredDirectoryPaths)
      .some((directoryPath) => relativePath === directoryPath || relativePath.startsWith(`${directoryPath}/`));
    for (const { relativePath } of walkFiles(root, platform)) {
      if (!declaredPaths.has(relativePath) && !coveredByDeclaredDirectory(relativePath) && !isAllowlisted(relativePath, platform)) {
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
