#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapTauriResourcePath } from './lib/tauri-resource-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function main() {
  const { root, target } = parseArgs(process.argv.slice(2));
  const appPackage = readJson(path.join(root, 'package.json'));
  const tauriConfig = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
  const resources = tauriConfig.bundle?.resources;
  const nativeRoot = !Array.isArray(resources) ? resources?.['../dist/native'] : undefined;
  if (typeof nativeRoot !== 'string') {
    throw new Error("Tauri resource mapping '../dist/native' must have a string target");
  }

  const entry = `${nativeRoot}/better-sqlite3`;
  const native = mapTauriResourcePath(`${entry}/prebuilds/darwin-arm64.node`, target);
  for (const declaredPath of [entry, native]) {
    if (!fs.existsSync(path.join(root, declaredPath))) {
      throw new Error(`Missing native dependency manifest path: ${declaredPath}`);
    }
  }

  const modulePackage = readJson(path.join(root, entry, 'package.json'));
  const manifest = {
    schemaVersion: 1,
    kind: 'agent_neo_native_dep_manifest',
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-native-dep-manifest.mjs',
    appVersion: appPackage.version,
    platform: target,
    modules: {
      'better-sqlite3': {
        kind: 'node-module',
        entry,
        native,
        packageVersion: modulePackage.version,
      },
    },
  };
  const outputPath = path.join(root, nativeRoot, 'manifest.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[native-dep-manifest] wrote ${nativeRoot}/manifest.json (${target})`);
}

try {
  main();
} catch (error) {
  console.error(`[native-dep-manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
