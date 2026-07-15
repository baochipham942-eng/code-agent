#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectPopplerPlatform,
  downloadPinnedArtifact,
  sha256File,
  validatePopplerLock,
  validatePopplerManifest,
  verifyPopplerSourceCoverage,
  verifyPopplerSourceDirectory,
  verifySidecarDirectory,
} from './lib/poppler-sidecar-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    lock: path.join(repoRoot, 'config/poppler-sidecar.lock.json'),
    output: path.join(repoRoot, 'scripts/poppler'),
    stageDir: null,
    platform: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--lock' && value) options.lock = path.resolve(value);
    else if (arg === '--output' && value) options.output = path.resolve(value);
    else if (arg === '--stage-dir' && value) options.stageDir = path.resolve(value);
    else if (arg === '--platform' && value) options.platform = value;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
    index += 1;
  }
  return options;
}

function assertSafeTar(archive) {
  const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error(`Cannot list sidecar archive: ${list.stderr}`);
  const entries = list.stdout.split('\n').filter(Boolean);
  if (entries.length === 0) throw new Error('Sidecar archive is empty');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')) {
      throw new Error(`Unsafe sidecar archive entry: ${entry}`);
    }
  }
  const verbose = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
  if (verbose.status !== 0) throw new Error(`Cannot inspect sidecar archive: ${verbose.stderr}`);
  for (const line of verbose.stdout.split('\n').filter(Boolean)) {
    if (line.startsWith('l') || line.startsWith('h') || line.includes(' link to ')) {
      throw new Error('Sidecar archive must not contain symbolic or hard links');
    }
  }
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archive, '-C', destination], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot extract sidecar archive: ${result.stderr}`);
}

function replaceDirectory(source, destination) {
  const backup = `${destination}.previous-${process.pid}`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(destination)) fs.renameSync(destination, backup);
  try {
    fs.renameSync(source, destination);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const lock = JSON.parse(fs.readFileSync(options.lock, 'utf8'));
  validatePopplerLock(lock);
  const platform = options.platform ?? detectPopplerPlatform();
  const platformEntry = lock.platforms[platform];
  if (!platformEntry) throw new Error(`Poppler lock has no promoted entry for ${platform}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-poppler-fetch-'));
  try {
    const manifestPath = path.join(tempRoot, 'poppler-sidecar-manifest.json');
    const sidecarArchive = path.join(tempRoot, 'poppler-sidecar.tar.gz');
    const sourceBundle = path.join(tempRoot, 'poppler-complete-source.tar.gz');
    await downloadPinnedArtifact(platformEntry.manifest.url, manifestPath, platformEntry.manifest);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    validatePopplerManifest(manifest, {
      expectedPlatform: platform,
      expectedVersion: lock.popplerBrewVersion,
    });

    await Promise.all([
      downloadPinnedArtifact(platformEntry.sidecarArchive.url, sidecarArchive, platformEntry.sidecarArchive),
      downloadPinnedArtifact(platformEntry.sourceBundle.url, sourceBundle, platformEntry.sourceBundle),
    ]);
    for (const [key, localPath] of [
      ['sidecarArchive', sidecarArchive],
      ['sourceBundle', sourceBundle],
    ]) {
      const expected = manifest.artifacts[key];
      const actualBytes = fs.statSync(localPath).size;
      if (expected.bytes !== actualBytes || expected.sha256 !== sha256File(localPath)) {
        throw new Error(`${key} does not match the signed-off manifest`);
      }
    }

    assertSafeTar(sidecarArchive);
    const extractedRoot = path.join(tempRoot, 'extracted');
    extractArchive(sidecarArchive, extractedRoot);
    verifySidecarDirectory(manifest, extractedRoot);
    assertSafeTar(sourceBundle);
    const extractedSourceRoot = path.join(tempRoot, 'complete-source');
    extractArchive(sourceBundle, extractedSourceRoot);
    const sourceManifestPath = path.join(extractedSourceRoot, manifest.source.manifestPath);
    if (!fs.existsSync(sourceManifestPath) || sha256File(sourceManifestPath) !== manifest.source.manifestSha256) {
      throw new Error('Complete-source manifest hash mismatch');
    }
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'));
    const sourceResult = verifyPopplerSourceDirectory(sourceManifest, extractedSourceRoot, {
      expectedVersion: lock.popplerBrewVersion,
    });
    verifyPopplerSourceCoverage(manifest, sourceManifest);
    if (sourceResult.componentCount !== manifest.source.componentCount) {
      throw new Error('Complete-source component count does not match sidecar manifest');
    }
    const embeddedManifestDir = path.join(extractedRoot, 'manifest');
    fs.mkdirSync(embeddedManifestDir, { recursive: true });
    fs.copyFileSync(manifestPath, path.join(embeddedManifestDir, 'sidecar-manifest.json'));
    replaceDirectory(extractedRoot, options.output);

    if (options.stageDir) {
      fs.mkdirSync(options.stageDir, { recursive: true });
      for (const [source, target] of [
        [manifestPath, `poppler-sidecar-manifest-${platform}.json`],
        [sidecarArchive, manifest.artifacts.sidecarArchive.file],
        [sourceBundle, manifest.artifacts.sourceBundle.file],
      ]) {
        fs.copyFileSync(source, path.join(options.stageDir, target));
      }
    }
    console.log(`Poppler ${lock.popplerBrewVersion} ${platform}: immutable sidecar verified`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[poppler-sidecar][FAIL] ${error.message}`);
  process.exitCode = 1;
});
