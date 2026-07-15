#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { sha256File } from './lib/poppler-sidecar-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs() {
  const result = { sidecar: path.join(repoRoot, 'scripts/poppler'), output: null };
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (name === '--sidecar' && value) result.sidecar = path.resolve(value);
    else if (name === '--output' && value) result.output = path.resolve(value);
    else throw new Error(`Unknown or incomplete argument: ${name}`);
  }
  if (!result.output) throw new Error('--output is required');
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function copyEvidence(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return {
    file: destination,
    sha256: sha256File(destination),
    bytes: fs.statSync(destination).size,
  };
}

function downloadEvidence(url, expectedSha256, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  run('curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', url, '--output', destination]);
  if (sha256File(destination) !== expectedSha256.toLowerCase()) {
    throw new Error(`Downloaded build input checksum mismatch: ${url}`);
  }
  return { file: destination, sha256: sha256File(destination), bytes: fs.statSync(destination).size };
}

function main() {
  const options = parseArgs();
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/poppler-sidecar.lock.json'), 'utf8'));
  const provenancePath = path.join(options.sidecar, 'compliance/binary-provenance.json');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  if (provenance.publisher !== 'Agent Neo project') throw new Error('Binary provenance publisher mismatch');
  const components = [...new Map(Object.values(provenance.files).map((entry) => [entry.component, entry])).values()]
    .sort((left, right) => left.component.localeCompare(right.component));
  if (!components.some((entry) => entry.component === 'poppler')) throw new Error('Provenance does not include Poppler');

  fs.rmSync(options.output, { recursive: true, force: true });
  fs.mkdirSync(options.output, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-poppler-sources-'));
  const manifestComponents = [];
  const notice = [
    'Agent Neo project - Poppler sidecar third-party notices',
    '',
    'The files in this sidecar are distributed under the licenses of Poppler and the exact',
    'runtime dependency versions listed below. Corresponding source archives, formulae,',
    'installation receipts and SHA-256 values are in the matching complete-source bundle.',
    '',
  ];

  try {
    for (const component of components) {
      const formulaRef = component.component === 'poppler'
        ? 'agent-neo/poppler-build/poppler'
        : component.component;
      const info = JSON.parse(run('brew', ['info', '--json=v2', formulaRef])).formulae[0];
      const installed = (info.installed ?? []).find((entry) => entry.version === component.componentVersion);
      if (!installed) throw new Error(`${component.component} ${component.componentVersion} is not the installed formula version`);
      const stable = info.urls?.stable;
      if (!stable?.url || !stable?.checksum) throw new Error(`${component.component} has no checksummed stable source URL`);

      run('brew', ['fetch', '--build-from-source', formulaRef]);
      const cacheLines = run('brew', ['--cache', '--build-from-source', formulaRef]).split('\n').filter(Boolean);
      const sourcePath = cacheLines.find((entry) => fs.existsSync(entry));
      if (!sourcePath) throw new Error(`Cannot locate fetched source archive for ${component.component}`);
      if (sha256File(sourcePath) !== stable.checksum.toLowerCase()) {
        throw new Error(`${component.component} source checksum does not match formula metadata`);
      }

      const componentRoot = path.join(options.output, 'components', component.component);
      const sourceName = path.basename(new URL(stable.url).pathname) || `${component.component}.source`;
      const sourceEvidence = copyEvidence(sourcePath, path.join(componentRoot, 'source', sourceName));
      const licenseArchives = [sourcePath];
      const formulaTarget = path.join(componentRoot, 'formula', `${component.component}.rb`);
      fs.mkdirSync(path.dirname(formulaTarget), { recursive: true });
      fs.writeFileSync(formulaTarget, `${run('brew', ['cat', formulaRef])}\n`);
      const formulaEvidence = {
        file: formulaTarget,
        sha256: sha256File(formulaTarget),
        bytes: fs.statSync(formulaTarget).size,
      };
      const receiptPath = path.join(run('brew', ['--cellar', component.component]), component.componentVersion, 'INSTALL_RECEIPT.json');
      const receiptEvidence = copyEvidence(receiptPath, path.join(componentRoot, 'receipt', 'INSTALL_RECEIPT.json'));

      const resourceProbe = `
        f = Formulary.factory(ARGV[0])
        values = f.stable.resources.values.map do |r|
          { name: r.name, url: r.url.to_s, checksum: r.checksum&.hexdigest, cache: r.cached_download.to_s }
        end
        puts JSON.generate(values)
      `;
      const resources = JSON.parse(run('brew', ['ruby', '-e', resourceProbe, formulaRef]));
      const buildInputs = [];
      for (const resource of resources) {
        if (!resource.url || !resource.checksum || !resource.cache || !fs.existsSync(resource.cache)) {
          throw new Error(`${component.component} resource ${resource.name} was not fetched with checksum metadata`);
        }
        const evidence = copyEvidence(
          resource.cache,
          path.join(componentRoot, 'build-inputs', 'resources', `${resource.name}-${path.basename(new URL(resource.url).pathname)}`),
        );
        if (evidence.sha256 !== resource.checksum.toLowerCase()) throw new Error(`${component.component} resource checksum mismatch`);
        licenseArchives.push(evidence.file);
        buildInputs.push({
          kind: 'resource',
          name: resource.name,
          url: resource.url,
          path: path.relative(options.output, evidence.file).split(path.sep).join('/'),
          sha256: evidence.sha256,
          bytes: evidence.bytes,
        });
      }

      const patches = info.patches ?? [];
      for (const [patchIndex, patch] of patches.entries()) {
        const patchName = patch.file ? path.basename(patch.file) : `external-${patchIndex + 1}.patch`;
        const destination = path.join(componentRoot, 'build-inputs', 'patches', patchName);
        let patchUrl;
        let evidence;
        if (patch.file) {
          if (info.tap !== 'homebrew/core' || !/^[a-f0-9]{40}$/.test(info.tap_git_head ?? '')) {
            throw new Error(`${component.component} local formula patch cannot be pinned to homebrew/core`);
          }
          patchUrl = `https://raw.githubusercontent.com/Homebrew/homebrew-core/${info.tap_git_head}/${patch.file}`;
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          run('curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', patchUrl, '--output', destination]);
          evidence = { file: destination, sha256: sha256File(destination), bytes: fs.statSync(destination).size };
        } else if (patch.url && patch.sha256) {
          patchUrl = patch.url;
          evidence = downloadEvidence(patchUrl, patch.sha256, destination);
        } else {
          throw new Error(`${component.component} has an unsupported formula patch definition`);
        }
        buildInputs.push({
          kind: 'patch',
          name: patchName,
          url: patchUrl,
          path: path.relative(options.output, evidence.file).split(path.sep).join('/'),
          sha256: evidence.sha256,
          bytes: evidence.bytes,
        });
      }

      const extractRoot = path.join(tempRoot, component.component);
      fs.mkdirSync(extractRoot, { recursive: true });
      for (const [archiveIndex, archive] of licenseArchives.entries()) {
        const archiveRoot = path.join(extractRoot, String(archiveIndex));
        fs.mkdirSync(archiveRoot, { recursive: true });
        run('tar', ['-xf', archive, '-C', archiveRoot]);
      }
      const licenseCandidates = run('find', [extractRoot, '-type', 'f', '(', '-iname', 'COPYING*', '-o', '-iname', 'LICENSE*', '-o', '-iname', 'COPYRIGHT*', '-o', '-iname', 'NOTICE*', '-o', '-path', '*/LICENSES/*', ')'])
        .split('\n').filter(Boolean).sort();
      if (licenseCandidates.length === 0) throw new Error(`${component.component} source archive has no discoverable license text`);
      const licenseFiles = licenseCandidates.map((source, index) => {
        const targetName = `${String(index + 1).padStart(2, '0')}-${path.basename(source)}`;
        const target = path.join(componentRoot, 'licenses', targetName);
        const evidence = copyEvidence(source, target);
        return { path: path.relative(options.output, evidence.file).split(path.sep).join('/'), sha256: evidence.sha256, bytes: evidence.bytes };
      });

      const relative = (evidence) => ({
        path: path.relative(options.output, evidence.file).split(path.sep).join('/'),
        sha256: evidence.sha256,
        bytes: evidence.bytes,
      });
      manifestComponents.push({
        name: component.component,
        version: component.componentVersion,
        builtFromSource: installed.built_as_bottle === false && installed.poured_from_bottle === false,
        declaredLicense: info.license ?? 'NOASSERTION',
        upstreamSourceUrl: stable.url,
        sourceArchive: relative(sourceEvidence),
        formula: relative(formulaEvidence),
        installReceipt: relative(receiptEvidence),
        formulaResourceCount: resources.length,
        formulaPatchCount: patches.length,
        buildInputs,
        licenseFiles,
      });
      notice.push(`${component.component} ${component.componentVersion}`);
      notice.push(`  Built from source: ${installed.built_as_bottle === false && installed.poured_from_bottle === false}`);
      notice.push(`  Declared license: ${info.license ?? 'NOASSERTION'}`);
      notice.push(`  Source: ${stable.url}`);
      notice.push(`  Source SHA-256: ${sourceEvidence.sha256}`, '');
    }

    const buildRoot = path.join(options.output, 'build-materials');
    fs.mkdirSync(buildRoot, { recursive: true });
    for (const relativePath of [
      'config/poppler-sidecar.lock.json',
      'scripts/fetch-poppler.sh',
      'scripts/collect-poppler-compliance.mjs',
      'scripts/build-poppler-sidecar-artifacts.mjs',
      'scripts/lib/poppler-sidecar-release.mjs',
    ]) {
      copyEvidence(path.join(repoRoot, relativePath), path.join(buildRoot, relativePath));
    }
    fs.writeFileSync(path.join(options.output, 'THIRD_PARTY_NOTICES.txt'), `${notice.join('\n')}\n`);
    fs.writeFileSync(path.join(options.output, 'source-manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_poppler_complete_source',
      publisher: 'Agent Neo project',
      popplerBrewVersion: lock.popplerBrewVersion,
      components: manifestComponents,
    }, null, 2)}\n`);

    const sidecarCompliance = path.join(options.sidecar, 'compliance');
    fs.rmSync(path.join(sidecarCompliance, 'licenses'), { recursive: true, force: true });
    fs.rmSync(path.join(sidecarCompliance, 'THIRD_PARTY_NOTICES.txt'), { force: true });
    fs.mkdirSync(path.join(sidecarCompliance, 'licenses'), { recursive: true });
    fs.copyFileSync(path.join(options.output, 'THIRD_PARTY_NOTICES.txt'), path.join(sidecarCompliance, 'THIRD_PARTY_NOTICES.txt'));
    for (const component of manifestComponents) {
      for (const license of component.licenseFiles) {
        const destination = path.join(sidecarCompliance, 'licenses', component.name, path.basename(license.path));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(options.output, license.path), destination);
      }
    }
    console.log(`Collected exact source and license evidence for ${manifestComponents.length} sidecar components`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[poppler-compliance][FAIL] ${error.message}`);
  process.exitCode = 1;
}
