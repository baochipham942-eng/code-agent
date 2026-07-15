#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  detectPopplerPlatform,
  sha256File,
  validatePopplerManifest,
  verifyPopplerSourceCoverage,
  verifyPopplerSourceDirectory,
  verifySidecarDirectory,
  walkRegularFiles,
} from './lib/poppler-sidecar-release.mjs';

function parseArgs() {
  const result = { sidecar: null, source: null, output: null, platform: null, runnerLabel: null };
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (name === '--sidecar' && value) result.sidecar = path.resolve(value);
    else if (name === '--source' && value) result.source = path.resolve(value);
    else if (name === '--output' && value) result.output = path.resolve(value);
    else if (name === '--platform' && value) result.platform = value;
    else if (name === '--runner-label' && value) result.runnerLabel = value;
    else throw new Error(`Unknown or incomplete argument: ${name}`);
  }
  if (!result.sidecar || !result.source || !result.output || !result.runnerLabel) {
    throw new Error('--sidecar, --source, --output and --runner-label are required');
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function createArchive(root, output) {
  fs.rmSync(output, { force: true });
  run('tar', ['-czf', output, '-C', root, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return { file: path.basename(output), sha256: sha256File(output), bytes: fs.statSync(output).size };
}

function main() {
  const options = parseArgs();
  const platform = options.platform ?? detectPopplerPlatform();
  const expectedArch = platform === 'darwin-arm64' ? 'arm64' : 'x86_64';
  const machineArchitecture = run('uname', ['-m']);
  if (machineArchitecture !== expectedArch) throw new Error(`Native runner mismatch: expected ${expectedArch}, found ${machineArchitecture}`);
  const translated = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' });
  if (translated.status === 0 && translated.stdout.trim() === '1') throw new Error('Rosetta-translated builds are forbidden');
  if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) {
    throw new Error('Promotion artifacts require GITHUB_RUN_ID and full GITHUB_SHA evidence');
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(options.sidecar, 'compliance/binary-provenance.json'), 'utf8'));
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(options.source, 'source-manifest.json'), 'utf8'));
  verifyPopplerSourceDirectory(sourceManifest, options.source);

  fs.rmSync(options.output, { recursive: true, force: true });
  fs.mkdirSync(options.output, { recursive: true });
  const version = sourceManifest.popplerBrewVersion;
  const sidecarName = `poppler-sidecar-${platform}-${version}.tar.gz`;
  const sourceName = `poppler-complete-source-${platform}-${version}.tar.gz`;
  const sidecarArtifact = createArchive(options.sidecar, path.join(options.output, sidecarName));
  const sourceArtifact = createArchive(options.source, path.join(options.output, sourceName));

  const files = walkRegularFiles(options.sidecar).map((filePath) => {
    const relativePath = path.relative(options.sidecar, filePath).split(path.sep).join('/');
    const binary = provenance.files?.[relativePath];
    const type = run('file', ['-b', filePath]);
    const isMachO = type.includes('Mach-O');
    if (isMachO) {
      const arches = run('lipo', ['-archs', filePath]).split(/\s+/).filter(Boolean);
      if (arches.length !== 1 || arches[0] !== expectedArch) {
        throw new Error(`${relativePath} must contain only ${expectedArch}; found ${arches.join(',')}`);
      }
      if (!binary) throw new Error(`Missing binary provenance for ${relativePath}`);
    }
    return {
      path: relativePath,
      sha256: sha256File(filePath),
      bytes: fs.statSync(filePath).size,
      mode: `0${(fs.statSync(filePath).mode & 0o777).toString(8).padStart(3, '0')}`,
      component: binary?.component ?? 'distribution-compliance',
      componentVersion: binary?.componentVersion ?? version,
      kind: isMachO ? 'mach-o' : 'data',
      ...(isMachO ? { arch: expectedArch } : {}),
    };
  });
  const manifest = {
    schemaVersion: 1,
    kind: 'agent_neo_poppler_sidecar',
    publisher: 'Agent Neo project',
    invocationBoundary: 'separate-process-file-io',
    platform,
    popplerBrewVersion: version,
    nativeBuild: {
      runnerKind: 'github-actions',
      runnerLabel: options.runnerLabel,
      machineArchitecture,
      rosettaTranslated: false,
      workflow: 'build-poppler-sidecar.yml',
      runId: process.env.GITHUB_RUN_ID,
      sourceCommit: process.env.GITHUB_SHA,
    },
    files,
    artifacts: { sidecarArchive: sidecarArtifact, sourceBundle: sourceArtifact },
    source: {
      manifestPath: 'source-manifest.json',
      manifestSha256: sha256File(path.join(options.source, 'source-manifest.json')),
      componentCount: sourceManifest.components.length,
    },
  };
  validatePopplerManifest(manifest, { expectedPlatform: platform, expectedVersion: version });
  verifyPopplerSourceCoverage(manifest, sourceManifest);
  verifySidecarDirectory(manifest, options.sidecar);
  const manifestPath = path.join(options.output, `poppler-sidecar-manifest-${platform}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${platform} candidate assets in ${options.output}`);
}

try {
  main();
} catch (error) {
  console.error(`[poppler-sidecar-build][FAIL] ${error.message}`);
  process.exitCode = 1;
}
