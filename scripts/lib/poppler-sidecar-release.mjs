import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

export const POPPLER_LOCK_KIND = 'agent_neo_poppler_sidecar_lock';
export const POPPLER_MANIFEST_KIND = 'agent_neo_poppler_sidecar';
export const POPPLER_PUBLISHER = 'Agent Neo project';
export const POPPLER_INVOCATION_BOUNDARY = 'separate-process-file-io';
export const POPPLER_PLATFORMS = ['darwin-arm64', 'darwin-x64'];

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_PUBLIC_METADATA_KEYS = new Set([
  'approvalIdentity',
  'approvedBy',
  'approver',
  'author',
  'buildHost',
  'builderIdentity',
  'email',
  'home',
  'homeDirectory',
  'host',
  'hostname',
  'internalReviewer',
  'maintainer',
  'maintainerEmail',
  'maintainerName',
  'owner',
  'personalEmail',
  'reviewedBy',
  'reviewer',
  'reviewerEmail',
  'reviewerName',
  'sourceRoot',
  'user',
  'username',
]);

export class PopplerReleaseGateError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PopplerReleaseGateError';
    this.code = options.code ?? 'poppler_release_gate_failed';
    this.details = options.details;
  }
}

function fail(message, code, details) {
  throw new PopplerReleaseGateError(message, { code, details });
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'invalid_object', { label });
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} is required`, 'missing_value', { label });
  }
  return value;
}

function assertSha256(value, label) {
  const normalized = assertString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    fail(`${label} must be a lowercase SHA-256 digest`, 'invalid_sha256', { label, value });
  }
  return normalized;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`, 'invalid_bytes', { label, value });
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`, 'invalid_count', { label, value });
  }
  return value;
}

function assertHttpsUrl(value, label) {
  const raw = assertString(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be a valid URL`, 'invalid_url', { label, value });
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    fail(`${label} must be an HTTPS URL without embedded credentials`, 'invalid_url', { label, value });
  }
  return parsed.toString();
}

function validateArtifactReference(value, label) {
  const artifact = assertObject(value, label);
  return {
    url: assertHttpsUrl(artifact.url, `${label}.url`),
    sha256: assertSha256(artifact.sha256, `${label}.sha256`),
    bytes: assertPositiveInteger(artifact.bytes, `${label}.bytes`),
  };
}

function validateManifestArtifact(value, label) {
  const artifact = assertObject(value, label);
  const file = assertString(artifact.file, `${label}.file`);
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) {
    fail(`${label}.file must be a safe relative path`, 'unsafe_artifact_path', { file });
  }
  return {
    file,
    sha256: assertSha256(artifact.sha256, `${label}.sha256`),
    bytes: assertPositiveInteger(artifact.bytes, `${label}.bytes`),
  };
}

function validateSourceEvidence(value, label) {
  const evidence = assertObject(value, label);
  const evidencePath = assertString(evidence.path, `${label}.path`);
  if (path.isAbsolute(evidencePath) || evidencePath.includes('\\') || evidencePath.split('/').includes('..')) {
    fail(`${label}.path must be a safe relative path`, 'unsafe_artifact_path', { path: evidencePath });
  }
  // 带上 evidencePath：合规失败时光有 components[16].licenseFiles[2] 这种下标，
  // 定位不到是哪个上游文件，排查只能重跑整条双架构 promotion（约 40 分钟）。
  return {
    path: evidencePath,
    sha256: assertSha256(evidence.sha256, `${label} (${evidencePath}).sha256`),
    bytes: assertPositiveInteger(evidence.bytes, `${label} (${evidencePath}).bytes`),
  };
}

export function assertPublicMetadataIsProjectOnly(value, label = 'public metadata') {
  const visit = (current, currentPath) => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }
    if (!current || typeof current !== 'object') {
      if (typeof current === 'string') {
        if (/(?:^|["'\s])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/.test(current)) {
          fail(`${currentPath} contains a local user path`, 'private_metadata', { path: currentPath });
        }
        if (/(?:^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:$|[^A-Za-z0-9.-])/.test(current)) {
          fail(`${currentPath} contains an email address`, 'private_metadata', { path: currentPath });
        }
        if (/(?:^|[^A-Za-z0-9.-])[A-Za-z0-9.-]+\.local(?:$|[^A-Za-z0-9.-])/i.test(current)) {
          fail(`${currentPath} contains a local hostname`, 'private_metadata', { path: currentPath });
        }
      }
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (FORBIDDEN_PUBLIC_METADATA_KEYS.has(key)) {
        fail(`${currentPath}.${key} is forbidden in public Poppler metadata`, 'private_metadata', {
          path: `${currentPath}.${key}`,
        });
      }
      visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, label);
}

export function validatePopplerLock(lock, { requireComplete = true } = {}) {
  assertObject(lock, 'Poppler lock');
  if (lock.schemaVersion !== 1 || lock.kind !== POPPLER_LOCK_KIND) {
    fail('Poppler lock schema/kind mismatch', 'invalid_lock', {
      schemaVersion: lock.schemaVersion,
      kind: lock.kind,
    });
  }
  if (lock.publisher !== POPPLER_PUBLISHER) {
    fail(`Poppler lock publisher must be ${POPPLER_PUBLISHER}`, 'invalid_publisher', {
      publisher: lock.publisher,
    });
  }
  if (lock.mainProgramLicense !== 'MIT') {
    fail('Poppler lock must preserve the Agent Neo MIT main-program license', 'invalid_main_license');
  }
  if (lock.invocationBoundary !== POPPLER_INVOCATION_BOUNDARY) {
    fail('Poppler lock invocation boundary mismatch', 'invalid_invocation_boundary', {
      invocationBoundary: lock.invocationBoundary,
    });
  }
  assertString(lock.licenseRationale, 'Poppler lock licenseRationale');
  assertString(lock.popplerBrewVersion, 'Poppler lock popplerBrewVersion');
  const formula = assertObject(lock.formula, 'Poppler lock formula');
  assertString(formula.repository, 'Poppler lock formula.repository');
  if (!/^[a-f0-9]{40}$/.test(assertString(formula.commit, 'Poppler lock formula.commit'))) {
    fail('Poppler lock formula.commit must be a full Git commit SHA', 'invalid_formula_commit');
  }
  assertString(formula.path, 'Poppler lock formula.path');
  assertSha256(formula.sha256, 'Poppler lock formula.sha256');

  const platforms = assertObject(lock.platforms, 'Poppler lock platforms');
  const platformKeys = Object.keys(platforms).sort();
  if (platformKeys.join(',') !== [...POPPLER_PLATFORMS].sort().join(',')) {
    fail('Poppler lock must contain exactly darwin-arm64 and darwin-x64', 'invalid_platforms', {
      platformKeys,
    });
  }

  const complete = lock.status === 'ready';
  if (requireComplete && !complete) {
    fail('Poppler sidecar lock is pending promotion; release remains stop-ship', 'pending_promotion', {
      status: lock.status,
    });
  }
  if (!complete && lock.status !== 'pending-promotion') {
    fail('Poppler lock status must be pending-promotion or ready', 'invalid_lock_status', {
      status: lock.status,
    });
  }
  const artifactBaseUrl = complete
    ? assertHttpsUrl(lock.artifactBaseUrl, 'Poppler lock artifactBaseUrl')
    : lock.artifactBaseUrl;
  if (complete && !artifactBaseUrl.endsWith('/')) {
    fail('Poppler lock artifactBaseUrl must end with /', 'invalid_artifact_origin');
  }
  if (!complete && artifactBaseUrl !== null) {
    fail('Pending Poppler lock artifactBaseUrl must remain null until promotion', 'invalid_artifact_origin');
  }

  for (const platform of POPPLER_PLATFORMS) {
    const entry = platforms[platform];
    if (!complete && entry === null) continue;
    const platformEntry = assertObject(entry, `Poppler lock platforms.${platform}`);
    for (const [kind, reference] of Object.entries({
      manifest: platformEntry.manifest,
      sidecarArchive: platformEntry.sidecarArchive,
      sourceBundle: platformEntry.sourceBundle,
    })) {
      const validated = validateArtifactReference(reference, `Poppler lock ${platform}.${kind}`);
      if (complete && !validated.url.startsWith(artifactBaseUrl)) {
        fail(`Poppler lock ${platform}.${kind} is outside the project-controlled artifact prefix`, 'invalid_artifact_origin');
      }
    }
  }

  assertPublicMetadataIsProjectOnly(lock, 'Poppler lock');
  return lock;
}

function validateManifestFile(file, index, expectedArch) {
  const label = `Poppler manifest files[${index}]`;
  const entry = assertObject(file, label);
  const relativePath = assertString(entry.path, `${label}.path`);
  if (path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').includes('..')) {
    fail(`${label}.path must stay inside the sidecar root`, 'unsafe_manifest_path', { relativePath });
  }
  assertSha256(entry.sha256, `${label}.sha256`);
  assertPositiveInteger(entry.bytes, `${label}.bytes`);
  if (!/^0[0-7]{3}$/.test(assertString(entry.mode, `${label}.mode`))) {
    fail(`${label}.mode must be a four-digit octal file mode`, 'invalid_file_mode');
  }
  assertString(entry.component, `${label}.component`);
  assertString(entry.componentVersion, `${label}.componentVersion`);
  if (entry.kind === 'mach-o') {
    if (entry.arch !== expectedArch) {
      fail(`${label}.arch mismatch`, 'architecture_mismatch', {
        expected: expectedArch,
        actual: entry.arch,
        relativePath,
      });
    }
  } else if (entry.kind !== 'data') {
    fail(`${label}.kind must be mach-o or data`, 'invalid_file_kind', { kind: entry.kind });
  }
  return entry;
}

export function validatePopplerManifest(manifest, { expectedPlatform, expectedVersion } = {}) {
  assertObject(manifest, 'Poppler manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== POPPLER_MANIFEST_KIND) {
    fail('Poppler manifest schema/kind mismatch', 'invalid_manifest', {
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
    });
  }
  if (manifest.publisher !== POPPLER_PUBLISHER) {
    fail(`Poppler manifest publisher must be ${POPPLER_PUBLISHER}`, 'invalid_publisher');
  }
  if (manifest.invocationBoundary !== POPPLER_INVOCATION_BOUNDARY) {
    fail('Poppler manifest invocation boundary mismatch', 'invalid_invocation_boundary');
  }
  const platform = assertString(manifest.platform, 'Poppler manifest platform');
  if (!POPPLER_PLATFORMS.includes(platform)) {
    fail('Poppler manifest platform is unsupported', 'invalid_platform', { platform });
  }
  if (expectedPlatform && platform !== expectedPlatform) {
    fail('Poppler manifest platform mismatch', 'platform_mismatch', {
      expected: expectedPlatform,
      actual: platform,
    });
  }
  const popplerBrewVersion = assertString(manifest.popplerBrewVersion, 'Poppler manifest popplerBrewVersion');
  if (expectedVersion && popplerBrewVersion !== expectedVersion) {
    fail('Poppler manifest version mismatch', 'version_mismatch', {
      expected: expectedVersion,
      actual: popplerBrewVersion,
    });
  }

  const nativeBuild = assertObject(manifest.nativeBuild, 'Poppler manifest nativeBuild');
  if (nativeBuild.runnerKind !== 'github-actions' || nativeBuild.workflow !== 'build-poppler-sidecar.yml') {
    fail('Poppler manifest must come from the approved GitHub Actions promotion workflow', 'invalid_build_evidence');
  }
  const expectedMachineArch = platform === 'darwin-arm64' ? 'arm64' : 'x86_64';
  const expectedRunnerLabel = platform === 'darwin-arm64' ? 'macos-latest' : 'macos-15-intel';
  if (nativeBuild.machineArchitecture !== expectedMachineArch
    || nativeBuild.runnerLabel !== expectedRunnerLabel
    || nativeBuild.rosettaTranslated !== false) {
    fail('Poppler manifest lacks native runner architecture evidence', 'non_native_build', {
      platform,
      nativeBuild,
    });
  }
  if (!/^\d+$/.test(assertString(nativeBuild.runId, 'Poppler manifest nativeBuild.runId'))
    || !/^[a-f0-9]{40}$/.test(assertString(nativeBuild.sourceCommit, 'Poppler manifest nativeBuild.sourceCommit'))) {
    fail('Poppler manifest build run/commit evidence is invalid', 'invalid_build_evidence');
  }

  const expectedArch = platform === 'darwin-arm64' ? 'arm64' : 'x86_64';
  if (!Array.isArray(manifest.files) || manifest.files.length < 2) {
    fail('Poppler manifest must list pdftoppm and its dependency files', 'missing_files');
  }
  const paths = new Set();
  manifest.files.forEach((file, index) => {
    const entry = validateManifestFile(file, index, expectedArch);
    if (paths.has(entry.path)) {
      fail(`Duplicate Poppler manifest path: ${entry.path}`, 'duplicate_manifest_path');
    }
    paths.add(entry.path);
  });
  if (!paths.has('bin/pdftoppm')) {
    fail('Poppler manifest is missing bin/pdftoppm', 'missing_pdftoppm');
  }
  const pdftoppmEntry = manifest.files.find((entry) => entry.path === 'bin/pdftoppm');
  if ((Number.parseInt(pdftoppmEntry.mode, 8) & 0o111) === 0) {
    fail('Poppler manifest bin/pdftoppm must be executable', 'invalid_file_mode');
  }
  if (!paths.has('compliance/THIRD_PARTY_NOTICES.txt')) {
    fail('Poppler manifest is missing compliance/THIRD_PARTY_NOTICES.txt', 'missing_notices');
  }
  if (![...paths].some((entry) => entry.startsWith('compliance/licenses/'))) {
    fail('Poppler manifest is missing compliance license texts', 'missing_license_texts');
  }

  const artifacts = assertObject(manifest.artifacts, 'Poppler manifest artifacts');
  validateManifestArtifact(artifacts.sidecarArchive, 'Poppler manifest artifacts.sidecarArchive');
  validateManifestArtifact(artifacts.sourceBundle, 'Poppler manifest artifacts.sourceBundle');
  const source = assertObject(manifest.source, 'Poppler manifest source');
  const sourceManifestPath = assertString(source.manifestPath, 'Poppler manifest source.manifestPath');
  if (path.isAbsolute(sourceManifestPath) || sourceManifestPath.includes('\\') || sourceManifestPath.split('/').includes('..')) {
    fail('Poppler manifest source.manifestPath must be a safe relative path', 'unsafe_manifest_path');
  }
  assertSha256(source.manifestSha256, 'Poppler manifest source.manifestSha256');
  assertPositiveInteger(source.componentCount, 'Poppler manifest source.componentCount');
  assertPublicMetadataIsProjectOnly(manifest, 'Poppler manifest');
  return manifest;
}

export function validatePopplerSourceManifest(manifest, { expectedVersion } = {}) {
  assertObject(manifest, 'Poppler source manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'agent_neo_poppler_complete_source') {
    fail('Poppler source manifest schema/kind mismatch', 'invalid_source_manifest');
  }
  if (manifest.publisher !== POPPLER_PUBLISHER) {
    fail(`Poppler source manifest publisher must be ${POPPLER_PUBLISHER}`, 'invalid_publisher');
  }
  const version = assertString(manifest.popplerBrewVersion, 'Poppler source manifest popplerBrewVersion');
  if (expectedVersion && version !== expectedVersion) {
    fail('Poppler source manifest version mismatch', 'version_mismatch', { expected: expectedVersion, actual: version });
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    fail('Poppler source manifest must contain components', 'missing_source_components');
  }
  const names = new Set();
  for (const [index, component] of manifest.components.entries()) {
    const label = `Poppler source manifest components[${index}]`;
    assertObject(component, label);
    const name = assertString(component.name, `${label}.name`);
    if (names.has(name)) fail(`Duplicate source component: ${name}`, 'duplicate_source_component');
    names.add(name);
    assertString(component.version, `${label}.version`);
    if (typeof component.builtFromSource !== 'boolean') {
      fail(`${label}.builtFromSource must be boolean`, 'invalid_source_provenance');
    }
    if (name === 'poppler' && component.builtFromSource !== true) {
      fail('Poppler promotion binary must be built from the pinned source formula', 'poppler_not_built_from_source');
    }
    assertString(component.declaredLicense, `${label}.declaredLicense`);
    assertHttpsUrl(component.upstreamSourceUrl, `${label}.upstreamSourceUrl`);
    validateSourceEvidence(component.sourceArchive, `${label}.sourceArchive`);
    validateSourceEvidence(component.formula, `${label}.formula`);
    validateSourceEvidence(component.installReceipt, `${label}.installReceipt`);
    const resourceCount = assertNonNegativeInteger(component.formulaResourceCount, `${label}.formulaResourceCount`);
    const patchCount = assertNonNegativeInteger(component.formulaPatchCount, `${label}.formulaPatchCount`);
    if (!Array.isArray(component.buildInputs) || component.buildInputs.length !== resourceCount + patchCount) {
      fail(`${label}.buildInputs must cover every formula resource and patch`, 'missing_build_inputs');
    }
    component.buildInputs.forEach((entry, inputIndex) => {
      assertString(entry.kind, `${label}.buildInputs[${inputIndex}].kind`);
      assertString(entry.name, `${label}.buildInputs[${inputIndex}].name`);
      assertHttpsUrl(entry.url, `${label}.buildInputs[${inputIndex}].url`);
      validateSourceEvidence(entry, `${label}.buildInputs[${inputIndex}]`);
    });
    if (!Array.isArray(component.licenseFiles) || component.licenseFiles.length === 0) {
      fail(`${label} must contain license texts`, 'missing_license_texts');
    }
    component.licenseFiles.forEach((entry, licenseIndex) => {
      validateSourceEvidence(entry, `${label}.licenseFiles[${licenseIndex}]`);
    });
  }
  if (!names.has('poppler')) fail('Poppler source manifest is missing Poppler itself', 'missing_poppler_source');
  assertPublicMetadataIsProjectOnly(manifest, 'Poppler source manifest');
  return manifest;
}

export function verifyPopplerSourceDirectory(manifest, sourceDir, { expectedVersion } = {}) {
  validatePopplerSourceManifest(manifest, { expectedVersion });
  for (const required of [
    'THIRD_PARTY_NOTICES.txt',
    'build-materials/config/poppler-sidecar.lock.json',
    'build-materials/scripts/fetch-poppler.sh',
    'build-materials/scripts/lib/poppler-sidecar-release.mjs',
  ]) {
    if (!fs.existsSync(path.join(sourceDir, required))) {
      fail(`Complete-source bundle is missing ${required}`, 'missing_source_material', { required });
    }
  }
  for (const component of manifest.components) {
    for (const evidence of [
      component.sourceArchive,
      component.formula,
      component.installReceipt,
      ...component.buildInputs,
      ...component.licenseFiles,
    ]) {
      const evidencePath = path.resolve(sourceDir, evidence.path);
      if (!evidencePath.startsWith(`${path.resolve(sourceDir)}${path.sep}`) || !fs.existsSync(evidencePath)) {
        fail(`Complete-source bundle is missing ${evidence.path}`, 'missing_source_material');
      }
      const stat = fs.statSync(evidencePath);
      if (!stat.isFile() || stat.size !== evidence.bytes || sha256File(evidencePath) !== evidence.sha256) {
        fail(`Complete-source evidence mismatch: ${evidence.path}`, 'source_evidence_mismatch');
      }
    }
  }
  return { componentCount: manifest.components.length };
}

export function verifyPopplerSourceCoverage(sidecarManifest, sourceManifest) {
  validatePopplerManifest(sidecarManifest);
  validatePopplerSourceManifest(sourceManifest, { expectedVersion: sidecarManifest.popplerBrewVersion });
  const binaryComponents = new Map();
  for (const file of sidecarManifest.files.filter((entry) => entry.kind === 'mach-o')) {
    const prior = binaryComponents.get(file.component);
    if (prior && prior !== file.componentVersion) {
      fail(`Sidecar component ${file.component} has conflicting versions`, 'component_version_mismatch');
    }
    binaryComponents.set(file.component, file.componentVersion);
  }
  const sourceComponents = new Map(sourceManifest.components.map((entry) => [entry.name, entry.version]));
  for (const [component, version] of binaryComponents) {
    if (sourceComponents.get(component) !== version) {
      fail(`Complete-source bundle does not match ${component} ${version}`, 'missing_component_source');
    }
  }
  for (const component of sourceComponents.keys()) {
    if (!binaryComponents.has(component)) {
      fail(`Complete-source bundle contains unreferenced component ${component}`, 'unreferenced_component_source');
    }
  }
  return { componentCount: binaryComponents.size };
}

export function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

// 把 pending lock 升成 ready lock：给双架构的 6 个制品填 url/sha256/bytes。
// 手填这 6 组是 promotion 里最容易出错的一步（gate 在 ready 时会逐字节对账 manifest，
// 错一位就整条发版 fail-closed），所以由候选目录的真实文件算出来，人只复核不誊抄。
// 产物末尾自证一次 requireComplete 校验：造不出合法 ready lock 就当场 fail，不落盘半成品。
export function buildReadyPopplerLock(pendingLock, { artifactBaseUrl, candidateFiles }) {
  if (pendingLock.status !== 'pending-promotion') {
    fail(`Only a pending-promotion lock can be promoted; got ${pendingLock.status}`, 'invalid_promotion_source');
  }
  const baseUrl = assertHttpsUrl(artifactBaseUrl, 'artifactBaseUrl');
  if (!baseUrl.endsWith('/')) fail('artifactBaseUrl must end with /', 'invalid_artifact_origin');

  const platforms = {};
  for (const platform of POPPLER_PLATFORMS) {
    const entry = assertObject(candidateFiles[platform], `candidateFiles.${platform}`);
    platforms[platform] = {};
    for (const kind of ['manifest', 'sidecarArchive', 'sourceBundle']) {
      const file = assertObject(entry[kind], `candidateFiles.${platform}.${kind}`);
      const name = assertString(file.name, `candidateFiles.${platform}.${kind}.name`);
      if (name.includes('/') || name.includes('\\')) {
        fail(`candidateFiles.${platform}.${kind}.name must be a bare file name`, 'unsafe_artifact_path', { name });
      }
      platforms[platform][kind] = {
        // 拼接而非 new URL(name, baseUrl)：后者会把 name 里的前导斜杠解成根路径，悄悄逃出前缀。
        url: `${baseUrl}${name}`,
        sha256: assertSha256(file.sha256, `candidateFiles.${platform}.${kind}.sha256`),
        bytes: assertPositiveInteger(file.bytes, `candidateFiles.${platform}.${kind}.bytes`),
      };
    }
  }

  const readyLock = { ...pendingLock, status: 'ready', artifactBaseUrl: baseUrl, platforms };
  validatePopplerLock(readyLock, { requireComplete: true });
  return readyLock;
}

// 上游会在源码树里放空的许可证占位文件（实测 zstd 1.5.7 的 build/LICENSE 是 0 字节）。
// 空文件不含任何许可证正文：收进合规包既履行不了 GPL 的「随附许可证正文」义务，也会
// 撞上清单校验对 bytes 的正整数断言。这里丢掉空候选；筛完一个不剩时由调用方 fail-closed，
// 因为「该组件的许可证正文一个都没找到」本身就是必须拦下的合规缺口。
// 排序用码元序（大写在小写前），与清单里的 NN- 前缀编号一致。
export function selectLicenseEvidenceFiles(candidatePaths) {
  return candidatePaths.filter((candidate) => fs.statSync(candidate).size > 0).sort();
}

export function walkRegularFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      } else if (entry.isSymbolicLink()) {
        fail(`Symlinks are forbidden in Poppler release artifacts: ${fullPath}`, 'symlink_forbidden');
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function verifySidecarDirectory(manifest, sidecarDir) {
  validatePopplerManifest(manifest);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const actualFiles = walkRegularFiles(sidecarDir)
    .map((filePath) => ({
      filePath,
      relativePath: path.relative(sidecarDir, filePath).split(path.sep).join('/'),
    }))
    .filter(({ relativePath }) => relativePath !== 'manifest/sidecar-manifest.json');

  const actualPaths = new Set(actualFiles.map(({ relativePath }) => relativePath));
  for (const expectedPath of expected.keys()) {
    if (!actualPaths.has(expectedPath)) {
      fail(`Extracted Poppler sidecar is missing ${expectedPath}`, 'missing_sidecar_file', { expectedPath });
    }
  }
  for (const { filePath, relativePath } of actualFiles) {
    const expectedEntry = expected.get(relativePath);
    if (!expectedEntry) {
      fail(`Extracted Poppler sidecar has unmanifested file ${relativePath}`, 'unmanifested_sidecar_file', {
        relativePath,
      });
    }
    const stat = fs.statSync(filePath);
    const actualMode = `0${(stat.mode & 0o777).toString(8).padStart(3, '0')}`;
    if (stat.size !== expectedEntry.bytes
      || sha256File(filePath) !== expectedEntry.sha256
      || actualMode !== expectedEntry.mode) {
      fail(`Extracted Poppler sidecar hash/size mismatch for ${relativePath}`, 'sidecar_file_mismatch', {
        relativePath,
      });
    }
  }
  return { fileCount: actualFiles.length };
}

export function detectPopplerPlatform({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin') {
    fail('Poppler sidecar release assets are supported only on macOS', 'unsupported_host', { platform, arch });
  }
  if (arch === 'arm64') return 'darwin-arm64';
  if (arch === 'x64') return 'darwin-x64';
  fail('Unsupported macOS architecture for Poppler sidecar', 'unsupported_architecture', { platform, arch });
}
