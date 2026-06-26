#!/usr/bin/env node
import path from 'path';
import process from 'process';
import { installRuntimeAssetFromManifest } from '../src/host/runtime/runtimeAssetInstaller';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const manifestPath = path.resolve(
  readArg('--manifest')
  ?? 'src-tauri/target/release/runtime-assets/manifest.json',
);
const assetId = readArg('--asset') ?? 'onnxruntime-vad';
const archivePath = readArg('--archive');
const runtimeBaseDir = readArg('--runtime-base-dir');
const keepPreviousArg = readArg('--keep-previous');
const keepPrevious = keepPreviousArg ? Number.parseInt(keepPreviousArg, 10) : undefined;

const result = await installRuntimeAssetFromManifest({
  manifestPath,
  assetId,
  archivePath,
  runtimeBaseDir,
  keepPrevious,
});

if (hasFlag('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[install-runtime-asset] ${result.assetId} -> ${result.root}`);
  console.log(`[install-runtime-asset] active manifest: ${result.activeManifestPath}`);
}
