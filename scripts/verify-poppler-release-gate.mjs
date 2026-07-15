#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  sha256File,
  validatePopplerLock,
  validatePopplerManifest,
  verifySidecarDirectory,
} from './lib/poppler-sidecar-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function assertInvocationBoundary() {
  const sourcePath = path.join(repoRoot, 'src/host/tools/media/ppt/visualReview.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const required = ['execSync(', "path.join('poppler', 'bin', 'pdftoppm')", '"${pdfPath}"'];
  for (const marker of required) {
    if (!source.includes(marker)) throw new Error(`pdftoppm independent-process boundary lost: ${marker}`);
  }
  const forbidden = [/\bffi\b/i, /\bdlopen\b/i, /shared[_ -]?memory/i, /node-?gyp/i];
  const popplerSection = source.slice(source.indexOf("resolveHelperBinary('pdftoppm'"));
  for (const pattern of forbidden) {
    if (pattern.test(popplerSection)) throw new Error(`pdftoppm boundary requires re-review: ${pattern}`);
  }
}

function main() {
  const lockPath = path.resolve(argumentValue('--lock') ?? path.join(repoRoot, 'config/poppler-sidecar.lock.json'));
  const allowPending = process.argv.includes('--allow-pending');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  validatePopplerLock(lock, { requireComplete: !allowPending });

  const rationale = path.resolve(repoRoot, lock.licenseRationale);
  if (!rationale.startsWith(`${repoRoot}${path.sep}`) || !fs.existsSync(rationale)) {
    throw new Error('Poppler license rationale is missing or outside the repository');
  }
  const rationaleText = fs.readFileSync(rationale, 'utf8');
  for (const marker of ['Agent Neo project', 'THIRD_PARTY_NOTICES.txt', 'macos-15-intel', '重新评估触发器']) {
    if (!rationaleText.includes(marker)) throw new Error(`Poppler license rationale is incomplete: ${marker}`);
  }
  assertInvocationBoundary();

  const manifestPath = argumentValue('--manifest');
  const sidecarDir = argumentValue('--sidecar-dir');
  if (manifestPath) {
    const resolvedManifestPath = path.resolve(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
    validatePopplerManifest(manifest, {
      expectedPlatform: argumentValue('--platform') ?? undefined,
      expectedVersion: lock.popplerBrewVersion,
    });
    if (lock.status === 'ready') {
      const lockedManifest = lock.platforms[manifest.platform]?.manifest;
      const stat = fs.statSync(resolvedManifestPath);
      if (!lockedManifest
        || stat.size !== lockedManifest.bytes
        || sha256File(resolvedManifestPath) !== lockedManifest.sha256) {
        throw new Error(`Poppler ${manifest.platform} manifest does not match the ready lock`);
      }
    }
    if (sidecarDir) verifySidecarDirectory(manifest, path.resolve(sidecarDir));
  } else if (sidecarDir) {
    throw new Error('--sidecar-dir requires --manifest');
  }

  console.log(`Poppler release gate: ${lock.status}${allowPending ? ' (structure only)' : ''}`);
}

try {
  main();
} catch (error) {
  console.error(`[poppler-release-gate][FAIL] ${error.message}`);
  process.exitCode = 1;
}
