#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapTauriResourcePath } from './lib/tauri-resource-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DARWIN_TARGETS = new Set(['darwin-arm64', 'darwin-x64']);
const NODE_PTY_RESOURCE_KEYS = {
  packageJson: '../node_modules/node-pty/package.json',
  prebuilds: '../node_modules/node-pty/prebuilds/darwin-arm64',
};
// node-pty 的 npm tarball 自带全平台 prebuilds；每个目标平台必须有的 .node 文件
// （win32 双文件易漏，ADR-086 §5 T6 风险行）。
const NODE_PTY_EXPECTED_NATIVES = {
  darwin: ['pty.node'],
  win32: ['conpty.node', 'pty.node'],
};
const SIDECAR_SPECS = {
  rtk: { resource: '../scripts/rtk', versionScript: 'fetch-rtk.sh', versionConstant: 'RTK_VERSION' },
  uv: { resource: '../scripts/uv', versionScript: 'fetch-uv.sh', versionConstant: 'UV_VERSION' },
};
const SWIFT_HELPER_RESOURCES = [
  '../scripts/system-audio-capture',
  '../scripts/voice-aec-io',
  '../scripts/vision-ocr',
  '../scripts/vision-tagger',
];
const POPPLER_RESOURCE = '../scripts/poppler';

// CUA helper 的渠道身份：与 scripts/lib/cua-channel.sh（shell 真源）同源——NEO_CHANNEL=dev 时
// stage 与 bundle 的都是 Dev 名字 .app（tauri.dev.conf.json 把生产键置 null）。空串按未设置
// 处理（shell `:-` 语义）。改渠道名要连 cua-channel.sh / src/shared/cuaHelperChannel.ts 一起。
function cuaAppResource() {
  const channel = process.env.NEO_CHANNEL || 'production';
  if (channel !== 'production' && channel !== 'dev') {
    throw new Error(`Unsupported NEO_CHANNEL: ${channel} (only production / dev)`);
  }
  const appName = channel === 'dev' ? 'Agent Neo Computer Use Dev' : 'Agent Neo Computer Use';
  return `../.tauri-resources.noindex/scripts/${appName}.app`;
}

function parseArgs(argv) {
  let target = `${process.platform}-${process.arch}`;
  let root = repoRoot;
  let targetProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--root requires a path');
      }
      root = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (targetProvided) {
      throw new Error(`Unexpected argument: ${argument}`);
    } else {
      target = argument;
      targetProvided = true;
    }
  }

  return { root, target };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resourceTarget(resources, sourceKey, target) {
  const baseTarget = resources[sourceKey];
  if (typeof baseTarget !== 'string') {
    throw new Error(`Tauri resource mapping '${sourceKey}' must have a string target`);
  }
  return mapTauriResourcePath(baseTarget, target);
}

// Resource source keys are src-tauri-relative ('../node_modules/keytar'); the on-disk
// input lives under the repo root, so drop the leading '../' after mapping. The CUA
// app's source stays under .tauri-resources.noindex/ while its bundle path is scripts/.
function resourceSource(resources, sourceKey, target) {
  const mapped = mapTauriResourcePath(sourceKey, target);
  return mapped.startsWith('../') ? mapped.slice(3) : mapped;
}

function requireExists(root, relativePath) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`Missing native dependency manifest path: ${relativePath}`);
  }
}

function listNodeFiles(root, directory) {
  requireExists(root, directory);
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
    .map((entry) => entry.name)
    .sort();
}

function sidecarVersion(root, versionScript, versionConstant) {
  try {
    const contents = fs.readFileSync(path.join(root, 'scripts', versionScript), 'utf8');
    const match = contents.match(new RegExp(`^\\s*${versionConstant}=["']([^"']+)["']`, 'm'));
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function buildModules(root, resources, nativeRoot, target) {
  const modules = {};

  const sqliteEntry = `${nativeRoot}/better-sqlite3`;
  const sqliteNative = mapTauriResourcePath(`${sqliteEntry}/prebuilds/darwin-arm64.node`, target);
  for (const declaredPath of [sqliteEntry, sqliteNative]) {
    requireExists(root, declaredPath);
  }
  modules['better-sqlite3'] = {
    kind: 'node-module',
    entry: sqliteEntry,
    native: sqliteNative,
    packageVersion: readJson(path.join(root, sqliteEntry, 'package.json')).version,
  };

  const keytarSource = resourceSource(resources, '../node_modules/keytar', target);
  const keytarNative = `${resourceTarget(resources, '../node_modules/keytar', target)}/build/Release/keytar.node`;
  requireExists(root, keytarNative);
  modules.keytar = {
    kind: 'node-module',
    entry: resourceTarget(resources, '../node_modules/keytar', target),
    native: keytarNative,
    packageVersion: readJson(path.join(root, keytarSource, 'package.json')).version,
  };

  const ptyPackageSource = resourceSource(resources, NODE_PTY_RESOURCE_KEYS.packageJson, target);
  requireExists(root, ptyPackageSource);
  const ptyPrebuildsSource = resourceSource(resources, NODE_PTY_RESOURCE_KEYS.prebuilds, target);
  const ptyNativeFiles = listNodeFiles(root, ptyPrebuildsSource);
  const expectedNatives = target.startsWith('win32')
    ? NODE_PTY_EXPECTED_NATIVES.win32
    : NODE_PTY_EXPECTED_NATIVES.darwin;
  for (const expected of expectedNatives) {
    if (!ptyNativeFiles.includes(expected)) {
      throw new Error(`Missing native dependency manifest path: ${ptyPrebuildsSource}/${expected}`);
    }
  }
  modules['node-pty'] = {
    kind: 'node-module',
    entry: path.posix.dirname(resourceTarget(resources, NODE_PTY_RESOURCE_KEYS.packageJson, target)),
    natives: ptyNativeFiles.map((name) => `${resourceTarget(resources, NODE_PTY_RESOURCE_KEYS.prebuilds, target)}/${name}`),
    packageVersion: readJson(path.join(root, ptyPackageSource)).version,
  };

  const sharpPackageSource = resourceSource(resources, '../node_modules/sharp/package.json', target);
  requireExists(root, sharpPackageSource);
  const sharpLibSource = resourceSource(resources, '../node_modules/@img/sharp-darwin-arm64/lib', target);
  const sharpLibTarget = resourceTarget(resources, '../node_modules/@img/sharp-darwin-arm64/lib', target);
  const sharpNativeFiles = listNodeFiles(root, sharpLibSource);
  if (sharpNativeFiles.length !== 1) {
    throw new Error(`Expected exactly one .node under ${sharpLibSource}, found: ${sharpNativeFiles.join(', ') || '(none)'}`);
  }
  modules.sharp = {
    kind: 'node-module',
    entry: path.posix.dirname(resourceTarget(resources, '../node_modules/sharp/package.json', target)),
    native: `${sharpLibTarget}/${sharpNativeFiles[0]}`,
    packageVersion: readJson(path.join(root, sharpPackageSource)).version,
  };

  for (const [id, spec] of Object.entries(SIDECAR_SPECS)) {
    const sidecarSource = resourceSource(resources, spec.resource, target);
    requireExists(root, sidecarSource);
    const version = sidecarVersion(root, spec.versionScript, spec.versionConstant);
    modules[id] = version === undefined
      ? { kind: 'tool-binary', path: resourceTarget(resources, spec.resource, target), executable: true }
      : { kind: 'tool-binary', path: resourceTarget(resources, spec.resource, target), executable: true, version };
  }

  if (!DARWIN_TARGETS.has(target)) {
    return modules;
  }

  requireExists(root, resourceSource(resources, POPPLER_RESOURCE, target));
  modules.poppler = { kind: 'helper-dir', path: resourceTarget(resources, POPPLER_RESOURCE, target) };

  for (const resource of SWIFT_HELPER_RESOURCES) {
    requireExists(root, resourceSource(resources, resource, target));
    modules[path.posix.basename(resourceTarget(resources, resource, target))] = {
      kind: 'helper-binary',
      path: resourceTarget(resources, resource, target),
      executable: true,
    };
  }

  const cuaResource = cuaAppResource();
  requireExists(root, resourceSource(resources, cuaResource, target));
  modules['computer-use-app'] = { kind: 'app-bundle', path: resourceTarget(resources, cuaResource, target) };

  return modules;
}

function main() {
  const { root, target } = parseArgs(process.argv.slice(2));
  const appPackage = readJson(path.join(root, 'package.json'));
  const tauriConfig = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
  const baseResources = tauriConfig.bundle?.resources;
  const nativeRoot = !Array.isArray(baseResources) ? baseResources?.['../dist/native'] : undefined;
  if (typeof nativeRoot !== 'string') {
    throw new Error("Tauri resource mapping '../dist/native' must have a string target");
  }

  // dev overlay（tauri.dev.conf.json）把生产 CUA 键置 null、补 Dev 名字键。渠道已决定查哪把
  // 键，冲突时以 base 为准（{...dev, ...base}）：null 删除标记只影响真的做 merge-patch 的
  // tauri build，本脚本按渠道选键，不会被 null 分支误导。overlay 缺席 = 纯生产树，照常工作。
  let resources = baseResources;
  try {
    const devOverlay = readJson(path.join(root, 'src-tauri', 'tauri.dev.conf.json')).bundle?.resources;
    if (devOverlay && typeof devOverlay === 'object' && !Array.isArray(devOverlay)) {
      resources = { ...devOverlay, ...baseResources };
    }
  } catch {
    // no dev overlay conf: production-only tree
  }

  const modules = buildModules(root, resources, nativeRoot, target);
  const manifest = {
    schemaVersion: 1,
    kind: 'agent_neo_native_dep_manifest',
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-native-dep-manifest.mjs',
    appVersion: appPackage.version,
    platform: target,
    modules,
  };
  const outputPath = path.join(root, nativeRoot, 'manifest.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[native-dep-manifest] wrote ${nativeRoot}/manifest.json (${target}, ${Object.keys(modules).length} modules)`);
}

try {
  main();
} catch (error) {
  console.error(`[native-dep-manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
