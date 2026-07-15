import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PopplerReleaseGateError,
  detectPopplerPlatform,
  sha256File,
  validatePopplerLock,
  validatePopplerManifest,
  validatePopplerSourceManifest,
  verifyPopplerSourceCoverage,
  verifySidecarDirectory,
} from '../../scripts/lib/poppler-sidecar-release.mjs';

const tempRoots: string[] = [];
const digest = 'a'.repeat(64);

function artifact(url = 'https://example.invalid/poppler.tar.gz') {
  return { url, sha256: digest, bytes: 1 };
}

function lock(status: 'pending-promotion' | 'ready' = 'pending-promotion') {
  const platformEntry = {
    manifest: artifact('https://example.invalid/manifest.json'),
    sidecarArchive: artifact('https://example.invalid/sidecar.tar.gz'),
    sourceBundle: artifact('https://example.invalid/source.tar.gz'),
  };
  return {
    schemaVersion: 1,
    kind: 'agent_neo_poppler_sidecar_lock',
    status,
    publisher: 'Agent Neo project',
    mainProgramLicense: 'MIT',
    invocationBoundary: 'separate-process-file-io',
    artifactBaseUrl: status === 'ready' ? 'https://example.invalid/' : null,
    licenseRationale: 'docs/architecture/decisions/ADR-040-C2a-poppler-license-rationale.md',
    popplerBrewVersion: '26.02.0_1',
    formula: {
      repository: 'Homebrew/homebrew-core',
      commit: 'b'.repeat(40),
      path: 'Formula/p/poppler.rb',
      sha256: digest,
    },
    platforms: {
      'darwin-arm64': status === 'ready' ? platformEntry : null,
      'darwin-x64': status === 'ready' ? platformEntry : null,
    },
  };
}

function makeSidecar() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppler-gate-test-'));
  tempRoots.push(root);
  const content: Record<string, string> = {
    'bin/pdftoppm': 'binary',
    'compliance/THIRD_PARTY_NOTICES.txt': 'notices',
    'compliance/licenses/poppler/COPYING': 'GPL text',
  };
  for (const [relativePath, value] of Object.entries(content)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
    if (relativePath === 'bin/pdftoppm') fs.chmodSync(target, 0o755);
  }
  return root;
}

function manifest(sidecarDir: string) {
  const fileEntries = [
    'bin/pdftoppm',
    'compliance/THIRD_PARTY_NOTICES.txt',
    'compliance/licenses/poppler/COPYING',
  ].map((relativePath) => ({
    path: relativePath,
    sha256: sha256File(path.join(sidecarDir, relativePath)),
    bytes: fs.statSync(path.join(sidecarDir, relativePath)).size,
    mode: relativePath === 'bin/pdftoppm' ? '0755' : '0644',
    component: relativePath.startsWith('bin/') ? 'poppler' : 'distribution-compliance',
    componentVersion: '26.02.0_1',
    kind: 'data',
  }));
  return {
    schemaVersion: 1,
    kind: 'agent_neo_poppler_sidecar',
    publisher: 'Agent Neo project',
    invocationBoundary: 'separate-process-file-io',
    platform: 'darwin-arm64',
    popplerBrewVersion: '26.02.0_1',
    nativeBuild: {
      runnerKind: 'github-actions',
      runnerLabel: 'macos-latest',
      machineArchitecture: 'arm64',
      rosettaTranslated: false,
      workflow: 'build-poppler-sidecar.yml',
      runId: '123456',
      sourceCommit: 'c'.repeat(40),
    },
    files: fileEntries,
    artifacts: {
      sidecarArchive: { file: 'poppler-sidecar-darwin-arm64.tar.gz', sha256: digest, bytes: 1 },
      sourceBundle: { file: 'poppler-complete-source-darwin-arm64.tar.gz', sha256: digest, bytes: 1 },
    },
    source: { manifestPath: 'source-manifest.json', manifestSha256: digest, componentCount: 1 },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Poppler release hard gate', () => {
  it('accepts pending lock only for structure checks and blocks formal release', () => {
    expect(() => validatePopplerLock(lock(), { requireComplete: false })).not.toThrow();
    expect(() => validatePopplerLock(lock())).toThrowError(expect.objectContaining({ code: 'pending_promotion' }));
  });

  it('requires ready arm64 and x64 immutable HTTPS references', () => {
    const ready = lock('ready');
    expect(() => validatePopplerLock(ready)).not.toThrow();
    ready.platforms['darwin-x64']!.sourceBundle.url = 'http://example.invalid/source.tar.gz';
    expect(() => validatePopplerLock(ready)).toThrowError(expect.objectContaining({ code: 'invalid_url' }));
  });

  it('rejects personal identity fields and local paths in public metadata', () => {
    const ready = lock('ready') as ReturnType<typeof lock> & { maintainer?: string; notes?: string };
    ready.maintainer = 'private person';
    expect(() => validatePopplerLock(ready)).toThrowError(expect.objectContaining({ code: 'private_metadata' }));
    delete ready.maintainer;
    ready.licenseRationale = '/Users/private/project/rationale.md';
    expect(() => validatePopplerLock(ready)).toThrowError(expect.objectContaining({ code: 'private_metadata' }));
    ready.licenseRationale = 'docs/architecture/decisions/ADR-040-C2a-poppler-license-rationale.md';
    ready.notes = 'reviewed by release@example.com on builder.local';
    expect(() => validatePopplerLock(ready)).toThrowError(expect.objectContaining({ code: 'private_metadata' }));
  });

  it('requires pdftoppm, notices, full license texts and matching architecture', () => {
    const sidecar = makeSidecar();
    const value = manifest(sidecar);
    expect(() => validatePopplerManifest(value)).not.toThrow();
    value.files[0] = { ...value.files[0], kind: 'mach-o', arch: 'x86_64' } as (typeof value.files)[number];
    expect(() => validatePopplerManifest(value)).toThrowError(expect.objectContaining({ code: 'architecture_mismatch' }));
  });

  it('rejects changed, missing and unmanifested extracted files', () => {
    const sidecar = makeSidecar();
    const value = manifest(sidecar);
    expect(verifySidecarDirectory(value, sidecar)).toEqual({ fileCount: 3 });
    fs.writeFileSync(path.join(sidecar, 'extra.dylib'), 'unexpected');
    expect(() => verifySidecarDirectory(value, sidecar)).toThrowError(expect.objectContaining({ code: 'unmanifested_sidecar_file' }));
    fs.rmSync(path.join(sidecar, 'extra.dylib'));
    fs.writeFileSync(path.join(sidecar, 'bin/pdftoppm'), 'changed');
    expect(() => verifySidecarDirectory(value, sidecar)).toThrowError(expect.objectContaining({ code: 'sidecar_file_mismatch' }));
  });

  it('allows only the lock-pinned embedded manifest outside the sidecar file list', () => {
    const sidecar = makeSidecar();
    const value = manifest(sidecar);
    const embeddedManifest = path.join(sidecar, 'manifest/sidecar-manifest.json');
    fs.mkdirSync(path.dirname(embeddedManifest), { recursive: true });
    fs.writeFileSync(embeddedManifest, `${JSON.stringify(value)}\n`);
    expect(verifySidecarDirectory(value, sidecar)).toEqual({ fileCount: 3 });
  });

  it('requires exact source, formula, receipt, license and every formula build input', () => {
    const evidence = { path: 'components/poppler/evidence', sha256: digest, bytes: 1 };
    const sourceManifest = {
      schemaVersion: 1,
      kind: 'agent_neo_poppler_complete_source',
      publisher: 'Agent Neo project',
      popplerBrewVersion: '26.02.0_1',
      components: [{
        name: 'poppler',
        version: '26.02.0_1',
        builtFromSource: true,
        declaredLicense: 'GPL-2.0-only OR GPL-3.0-only',
        upstreamSourceUrl: 'https://poppler.freedesktop.org/poppler-26.02.0.tar.xz',
        sourceArchive: evidence,
        formula: evidence,
        installReceipt: evidence,
        formulaResourceCount: 1,
        formulaPatchCount: 0,
        buildInputs: [{
          ...evidence,
          kind: 'resource',
          name: 'font-data',
          url: 'https://poppler.freedesktop.org/poppler-data-0.4.12.tar.gz',
        }],
        licenseFiles: [evidence],
      }],
    };
    expect(() => validatePopplerSourceManifest(sourceManifest)).not.toThrow();
    sourceManifest.components[0].buildInputs = [];
    expect(() => validatePopplerSourceManifest(sourceManifest))
      .toThrowError(expect.objectContaining({ code: 'missing_build_inputs' }));
  });

  it('requires exact source coverage for every Mach-O component and version', () => {
    const sidecar = makeSidecar();
    const sidecarManifest = manifest(sidecar);
    sidecarManifest.files[0] = {
      ...sidecarManifest.files[0],
      kind: 'mach-o',
      arch: 'arm64',
    } as (typeof sidecarManifest.files)[number];
    const evidence = { path: 'components/poppler/evidence', sha256: digest, bytes: 1 };
    const sourceManifest = {
      schemaVersion: 1,
      kind: 'agent_neo_poppler_complete_source',
      publisher: 'Agent Neo project',
      popplerBrewVersion: '26.02.0_1',
      components: [{
        name: 'poppler',
        version: '26.02.0_1',
        builtFromSource: true,
        declaredLicense: 'GPL-2.0-only',
        upstreamSourceUrl: 'https://poppler.freedesktop.org/poppler-26.02.0.tar.xz',
        sourceArchive: evidence,
        formula: evidence,
        installReceipt: evidence,
        formulaResourceCount: 0,
        formulaPatchCount: 0,
        buildInputs: [],
        licenseFiles: [evidence],
      }],
    };
    expect(verifyPopplerSourceCoverage(sidecarManifest, sourceManifest)).toEqual({ componentCount: 1 });
    sourceManifest.components[0].version = '26.07.0';
    expect(() => verifyPopplerSourceCoverage(sidecarManifest, sourceManifest))
      .toThrowError(expect.objectContaining({ code: 'missing_component_source' }));
  });

  it('maps only native supported macOS architectures', () => {
    expect(detectPopplerPlatform({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
    expect(detectPopplerPlatform({ platform: 'darwin', arch: 'x64' })).toBe('darwin-x64');
    expect(() => detectPopplerPlatform({ platform: 'linux', arch: 'x64' })).toThrow(PopplerReleaseGateError);
  });
});
