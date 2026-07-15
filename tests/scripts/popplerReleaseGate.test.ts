import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';
import {
  PopplerReleaseGateError,
  assertCrossPlatformComponentParity,
  buildReadyPopplerLock,
  detectPopplerPlatform,
  selectLicenseEvidenceFiles,
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
      runnerLabel: 'macos-15',
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

  // 复刻 zstd 1.5.7 源码树的真实布局：COPYING(GPL) 与 LICENSE(BSD) 有正文，
  // build/LICENSE 是 0 字节占位。首次真实 promotion 候选跑就是栽在这个空文件上。
  function makeLicenseTree(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppler-license-test-'));
    tempRoots.push(root);
    return Object.entries(files).map(([relativePath, content]) => {
      const full = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    });
  }

  it('drops empty upstream license placeholders but keeps every real license text', () => {
    const candidates = makeLicenseTree({
      COPYING: 'GPL-2.0 full text',
      LICENSE: 'BSD-3-Clause full text',
      'build/LICENSE': '',
    });

    const selected = selectLicenseEvidenceFiles(candidates);

    expect(selected.map((file) => path.basename(file))).toEqual(['COPYING', 'LICENSE']);
    expect(selected.every((file) => fs.statSync(file).size > 0)).toBe(true);
    // 空占位必须被丢掉：它进清单就会撞上 bytes 正整数断言，整条 promotion 挂死。
    expect(selected).not.toContain(candidates[2]);
  });

  it('keeps code-unit ordering so manifest NN- prefixes stay stable', () => {
    const candidates = makeLicenseTree({
      'build/LICENSE': 'nested text',
      LICENSE: 'root license',
      COPYING: 'root copying',
    });

    expect(selectLicenseEvidenceFiles(candidates)).toEqual([...candidates].sort());
  });

  it('returns nothing when a component only ships empty license placeholders', () => {
    // 调用方据此 fail-closed —— 「许可证正文一个都没找到」是必须拦下的合规缺口，
    // 不能因为过滤掉空文件就把这个组件静默放行。
    const candidates = makeLicenseTree({ LICENSE: '', 'build/COPYING': '' });

    expect(selectLicenseEvidenceFiles(candidates)).toEqual([]);
  });

  function candidateFiles(overrides: Record<string, unknown> = {}) {
    const entry = () => ({
      manifest: { name: 'poppler-sidecar-manifest-darwin-arm64.json', sha256: digest, bytes: 12 },
      sidecarArchive: { name: 'poppler-sidecar-darwin-arm64-26.02.0_1.tar.gz', sha256: digest, bytes: 34 },
      sourceBundle: { name: 'poppler-complete-source-darwin-arm64-26.02.0_1.tar.gz', sha256: digest, bytes: 56 },
    });
    return { 'darwin-arm64': entry(), 'darwin-x64': entry(), ...overrides };
  }

  it('keeps the promotion runner matrix and the manifest runner allowlist in lockstep', () => {
    // 两处必须一致却分居两个文件：workflow 的 matrix 决定候选实际跑在哪个 runner，
    // validatePopplerManifest 里钉死了它认哪个标签。只改一边，候选会一律判非原生——
    // 而且要等 6 分钟真编译完才在最后一步炸（2026-07-15 真踩过）。这条把两边绑死。
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = loadYaml(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-poppler-sidecar.yml'), 'utf8'));
    const matrix = workflow.jobs.build.strategy.matrix.include;
    expect(matrix.map((entry) => entry.platform)).toEqual(['darwin-arm64', 'darwin-x64']);

    for (const entry of matrix) {
      const candidate = manifest(makeSidecar());
      candidate.platform = entry.platform;
      candidate.nativeBuild.runnerLabel = entry.runner;
      candidate.nativeBuild.machineArchitecture = entry.uname_arch;
      for (const file of candidate.files) {
        if (file.kind === 'mach-o') file.arch = entry.uname_arch;
      }

      expect(
        () => validatePopplerManifest(candidate, { expectedPlatform: entry.platform, expectedVersion: '26.02.0_1' }),
        `${entry.platform}: workflow runs on '${entry.runner}' but the manifest allowlist rejects it`,
      ).not.toThrow();
    }
  });

  // 复刻 2026-07-15 真实候选对账的形状：只钉 poppler.rb 而放任 brew 从 runner 当下快照
  // 解析依赖时，两个 runner 镜像编出了不同版本的 jpeg-turbo/gpgme/libtiff。
  function manifestWithComponents(components: Record<string, string>) {
    return {
      files: Object.entries(components).map(([component, componentVersion]) => ({
        path: `lib/${component}.dylib`,
        component,
        componentVersion,
        kind: 'mach-o',
      })),
    };
  }

  it('refuses candidates whose architectures disagree on any dependency version', () => {
    expect(() => assertCrossPlatformComponentParity({
      'darwin-arm64': manifestWithComponents({ poppler: '26.02.0_1', 'jpeg-turbo': '3.2.0', gpgme: '2.1.2' }),
      'darwin-x64': manifestWithComponents({ poppler: '26.02.0_1', 'jpeg-turbo': '3.1.4.1', gpgme: '2.1.1' }),
    })).toThrowError(expect.objectContaining({ code: 'cross_platform_version_drift' }));
  });

  it('reports every drifting component, not just the first one', () => {
    try {
      assertCrossPlatformComponentParity({
        'darwin-arm64': manifestWithComponents({ 'jpeg-turbo': '3.2.0', gpgme: '2.1.2', libtiff: '4.7.2' }),
        'darwin-x64': manifestWithComponents({ 'jpeg-turbo': '3.1.4.1', gpgme: '2.1.1', libtiff: '4.7.1_1' }),
      });
      throw new Error('expected a drift failure');
    } catch (error) {
      // 一次列全，否则每修一个就得再烧一轮双架构 CI 才看到下一个。
      expect((error as PopplerReleaseGateError).details.mismatches).toHaveLength(3);
      expect((error as Error).message).toContain('jpeg-turbo 3.2.0 vs 3.1.4.1');
    }
  });

  it('catches a component present on one architecture but missing on the other', () => {
    expect(() => assertCrossPlatformComponentParity({
      'darwin-arm64': manifestWithComponents({ poppler: '26.02.0_1', 'jpeg-turbo': '3.2.0' }),
      'darwin-x64': manifestWithComponents({ poppler: '26.02.0_1' }),
    })).toThrowError(expect.objectContaining({ code: 'cross_platform_version_drift' }));
  });

  it('accepts architectures that agree on every component version', () => {
    const components = { poppler: '26.02.0_1', 'jpeg-turbo': '3.1.3', gpgme: '2.1.1' };
    expect(() => assertCrossPlatformComponentParity({
      'darwin-arm64': manifestWithComponents(components),
      'darwin-x64': manifestWithComponents(components),
    })).not.toThrow();
  });

  it('promotes a pending lock to ready with project-controlled URLs for both architectures', () => {
    const ready = buildReadyPopplerLock(lock('pending-promotion'), {
      artifactBaseUrl: 'https://example.invalid/poppler-sidecar/26.02.0_1/',
      candidateFiles: candidateFiles(),
    });

    expect(ready.status).toBe('ready');
    expect(ready.artifactBaseUrl).toBe('https://example.invalid/poppler-sidecar/26.02.0_1/');
    expect(ready.platforms['darwin-x64'].sidecarArchive.url).toBe(
      'https://example.invalid/poppler-sidecar/26.02.0_1/poppler-sidecar-darwin-arm64-26.02.0_1.tar.gz',
    );
    // bytes/sha256 必须原样落进 lock：gate 在 ready 时拿它跟真文件逐字节对账，差一位就整条发版挂。
    expect(ready.platforms['darwin-arm64'].sourceBundle).toMatchObject({ sha256: digest, bytes: 56 });
    // promotion 不得顺手改动许可证/formula 这些已复核过的字段。
    expect(ready.formula).toEqual(lock('pending-promotion').formula);
    expect(ready.popplerBrewVersion).toBe('26.02.0_1');
  });

  it('refuses a candidate file name that would escape the project-controlled prefix', () => {
    // 前导斜杠若被当成 URL 路径解析，会逃出 artifactBaseUrl 前缀落到桶根——lock 层的
    // 归属校验就形同虚设，因此在造 lock 时就必须拦下，而不是等 gate 事后发现。
    expect(() => buildReadyPopplerLock(lock('pending-promotion'), {
      artifactBaseUrl: 'https://example.invalid/poppler-sidecar/26.02.0_1/',
      candidateFiles: candidateFiles({
        'darwin-x64': {
          manifest: { name: '/evil/manifest.json', sha256: digest, bytes: 12 },
          sidecarArchive: { name: 'sidecar.tar.gz', sha256: digest, bytes: 34 },
          sourceBundle: { name: 'source.tar.gz', sha256: digest, bytes: 56 },
        },
      }),
    })).toThrow(PopplerReleaseGateError);
  });

  it('refuses to promote unless the source lock is pending and the base URL is a safe HTTPS prefix', () => {
    const args = {
      artifactBaseUrl: 'https://example.invalid/poppler-sidecar/26.02.0_1/',
      candidateFiles: candidateFiles(),
    };
    // 重复 promote 已 ready 的 lock = 覆盖已发布制品的引用，必须拦。
    expect(() => buildReadyPopplerLock(lock('ready'), args)).toThrow(PopplerReleaseGateError);
    expect(() => buildReadyPopplerLock(lock('pending-promotion'), { ...args, artifactBaseUrl: 'http://example.invalid/x/' }))
      .toThrow(PopplerReleaseGateError);
    // 少了结尾斜杠，拼出来的就是同级兄弟路径而非目录前缀。
    expect(() => buildReadyPopplerLock(lock('pending-promotion'), { ...args, artifactBaseUrl: 'https://example.invalid/x' }))
      .toThrow(PopplerReleaseGateError);
  });

  it('refuses to promote when either architecture candidate is absent', () => {
    expect(() => buildReadyPopplerLock(lock('pending-promotion'), {
      artifactBaseUrl: 'https://example.invalid/poppler-sidecar/26.02.0_1/',
      candidateFiles: { 'darwin-arm64': candidateFiles()['darwin-arm64'] },
    })).toThrow(PopplerReleaseGateError);
  });
});
