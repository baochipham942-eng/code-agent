import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

type WorkflowStep = {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
  needs?: string | string[];
  if?: string;
};

type WorkflowFile = {
  on?: unknown;
  jobs?: Record<string, WorkflowJob>;
};

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function readWorkflow(path: string): WorkflowFile {
  return loadYaml(readRepoFile(path)) as WorkflowFile;
}

type TauriResources = string[] | Record<string, string | null>;

function readTauriResources(): { sources: string[]; targets: string[]; map: Record<string, string> } {
  const tauriConfig = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
    bundle?: { resources?: TauriResources };
  };
  const resources = tauriConfig.bundle?.resources ?? [];
  const map = Array.isArray(resources)
    ? Object.fromEntries(resources.map((resource) => [resource, resource]))
    : Object.fromEntries(
      Object.entries(resources).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

  return {
    sources: Object.keys(map),
    targets: Object.values(map),
    map,
  };
}

function applyResourceMergePatch(
  base: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const merged = { ...base };
  for (const [source, target] of Object.entries(patch)) {
    if (target === null) {
      delete merged[source];
    } else {
      merged[source] = target;
    }
  }
  return merged;
}

function readWorkflowTriggers(path: string): Record<string, { paths?: string[]; tags?: string[] }> {
  const workflow = readWorkflow(path) as Record<string, unknown>;
  const triggers = (workflow.on ?? workflow['on']) as Record<string, { paths?: string[] }> | undefined;
  if (!triggers) {
    throw new Error(`${path} must define workflow triggers`);
  }
  return triggers;
}

function runReleaseBundle(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['scripts/tauri-release-bundle.sh'], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('macOS release fail-closed gates', () => {
  it('requires updater signing material before building updater artifacts', () => {
    const result = runReleaseBundle({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TAURI_UPDATER_PUBKEY or TAURI_UPDATER_PUBKEY_PATH is required');
  });

  it('requires an explicit Developer ID Application identity when notarization is required', () => {
    const result = runReleaseBundle({
      REQUIRE_NOTARIZATION: '1',
      TAURI_UPDATER_PUBKEY: 'updater-public-key',
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
      APPLE_ID: 'release@example.com',
      APPLE_PASSWORD: 'app-specific-password',
      APPLE_TEAM_ID: 'TEAM123456',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY is required',
    );
  });

  it('rejects non-Developer ID identities for release signing', () => {
    const result = runReleaseBundle({
      REQUIRE_NOTARIZATION: '1',
      TAURI_UPDATER_PUBKEY: 'updater-public-key',
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
      APPLE_ID: 'release@example.com',
      APPLE_PASSWORD: 'app-specific-password',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_SIGNING_IDENTITY: 'Apple Development: Agent Neo',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be a Developer ID Application identity');
  });

  it('requires Apple notarization credentials when notarization is enabled', () => {
    const result = runReleaseBundle({
      REQUIRE_NOTARIZATION: '1',
      TAURI_UPDATER_PUBKEY: 'updater-public-key',
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Agent Neo (TEAM123456)',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Apple notarization credentials are incomplete');
  });

  it('keeps notarization, Gatekeeper, TeamIdentifier, and control-plane checks in verify script', () => {
    const verifyScript = readRepoFile('scripts/verify-macos-release.sh');

    expect(verifyScript).toContain('LEGACY_RESOURCES_ROOT="${APP_RESOURCES_DIR}/_up_"');
    expect(verifyScript).toContain('RESOURCES_ROOT="${APP_RESOURCES_DIR}"');
    expect(verifyScript).toContain('dist/bundled-node/bin/node');
    expect(verifyScript).toContain('dist/native/better-sqlite3/build/Release/better_sqlite3.node');
    expect(verifyScript).toContain('better-sqlite3 native loads with bundled Node ABI');
    expect(verifyScript).toContain('codesign --verify --deep --strict');
    expect(verifyScript).toContain('Authority=Developer ID Application:');
    expect(verifyScript).toContain('TeamIdentifier=[A-Za-z0-9]');
    expect(verifyScript).toContain('xcrun stapler validate "${APP_PATH}"');
    expect(verifyScript).toContain('xcrun stapler validate "${dmg_path}"');
    expect(verifyScript).toContain('spctl --assess --type execute');
    expect(verifyScript).toContain('spctl --assess --type open');
    expect(verifyScript).toContain('control-plane public keys file has no keys');
  });

  it('verifies the updater pubkey is injected into the built binary (no placeholder ships)', () => {
    // v0.20.0 曾把源码占位符当公钥发布 → 已安装端下载更新到 100% 后验签必败、无法自动更新。
    // 这三处守卫保证「占位符泄漏进最终二进制」的版本会在发版时直接失败，而不是悄悄发出去。
    const PLACEHOLDER = 'DISABLED_LOCAL_BUILD_USE_TAURI_RELEASE_BUNDLE';

    const verifier = readRepoFile('scripts/verify-updater-pubkey.mjs');
    expect(verifier).toContain(PLACEHOLDER);
    expect(verifier).toContain('process.env.TAURI_UPDATER_PUBKEY');

    const bundleScript = readRepoFile('scripts/tauri-release-bundle.sh');
    expect(bundleScript).toContain('scripts/verify-updater-pubkey.mjs');

    const winVerify = readRepoFile('scripts/verify-windows-release.mjs');
    expect(winVerify).toContain(PLACEHOLDER);
    expect(winVerify).toContain('code-agent-tauri.exe');
  });

  it('keeps release workflow publishing updater archives and signatures', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('REQUIRE_NOTARIZATION:');
    expect(workflow).toContain('APPLE_CERTIFICATE_P12_BASE64');
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY');
    expect(workflow).toContain('TAURI_UPDATER_PUBKEY');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS');
    expect(workflow).toContain('actions: read');
    // 双架构（2026-06-10 起）：updater 归档 + 签名经 release-assets 制品发布，
    // 按架构命名防覆盖；合并后的 latest.json 必须同时含两个平台键（缺键 fail-fast）
    expect(workflow).toContain('release-assets/*.app.tar.gz');
    expect(workflow).toContain('release-assets/*.app.tar.gz.sig');
    expect(workflow).toContain('Agent.Neo-x64.app.tar.gz');
    expect(workflow).toContain('macos-15-intel');
    expect(workflow).toContain("'darwin-aarch64', 'darwin-x86_64'");
    expect(workflow).toContain('--dmg-url-x64');
    // Windows leg（windows-support.md §4 P2 矩阵折入，2026-06-11）：独立 build-windows job
    // 产 NSIS unsigned + minisign，publish 合并 windows-x86_64 键 + stable exe；
    // windows 失败降级 mac-only（required keys 不含 windows 键、EXE_ARGS 留空）
    expect(workflow).toContain('build-windows:');
    expect(workflow).toContain('windows-latest');
    expect(workflow).toContain('tauri-platform-config.mjs win32-x64');
    expect(workflow).toContain('scripts/verify-windows-release.mjs --stage pre');
    expect(workflow).toContain('scripts/verify-windows-release.mjs --stage post');
    expect(workflow).toContain('latest-win-x64.json');
    expect(workflow).toContain("required.push('windows-x86_64')");
    expect(workflow).toContain('release-assets/*-setup.exe');
    expect(workflow).toContain('release-assets/*-setup.exe.sig');
    expect(workflow).toContain('--exe-url');
    expect(workflow).toContain('win-x64-setup.exe');
    expect(workflow).toContain('npm run release:runtime-assets');
    expect(workflow).toContain('runtime-assets-manifest-darwin-arm64.json');
    expect(workflow).toContain('scripts/verify-runtime-assets-publish.mjs');
    expect(workflow).toContain('RUNTIME_ASSETS_MANIFEST_URL');
    expect(workflow).toContain('RUNTIME_ASSETS_MANIFEST_SHA256');
    expect(workflow).toContain('--runtime-assets-manifest-url');
    expect(workflow).toContain('payload.runtimeAssets');
    expect(workflow).toContain('release-assets/runtime-assets-manifest-*.sha256');
    expect(workflow).toContain('release-assets/*.tar.gz');
    expect(workflow).toContain('Verify renderer hot-update release gate');
    expect(workflow).toContain('npm run renderer:verify-release-gate --');
    expect(workflow).toContain('--workflow renderer-bundle.yml');
    expect(workflow).toContain('--head-sha "${GITHUB_SHA}"');
    expect(workflow).toContain('--workflow-branch "${GITHUB_REF_NAME}"');
    expect(workflow).toContain('--workflow-expected-conclusion success');
    expect(workflow).toContain('--expected-version "${VERSION}"');
    expect(workflow).toContain('--expected-release-channel latest');
    expect(workflow).toContain('--retry-attempts 12');
    expect(workflow).toContain('--retry-delay-ms 30000');
    expect(workflow).not.toContain('\t');
  });

  it('keeps formal app releases fail-closed before app artifacts are published', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    // 双架构（2026-06-10 起）：构建在 build-mac 矩阵，发布收口在 publish 任务。
    // fail-closed 链 = build-mac 内（probe → 门禁 → repack）+ publish needs build-mac
    // （任一架构失败则 GitHub Release / stable 提升不会执行）。
    const steps = workflow.jobs?.['build-mac']?.steps ?? [];
    const stepNames = steps.map((step) => step.name);
    const buildBundle = steps.find((step) => step.name === 'Build signed Tauri updater bundle');
    const buildBundleRun = buildBundle?.run ?? '';
    const verifierIndex = stepNames.indexOf('Verify renderer hot-update release gate');
    const rendererProbeIndex = stepNames.indexOf('Smoke-probe renderer startup (block publish on ErrorBoundary crash)');
    const repackIndex = stepNames.indexOf('Repack updater archive (clean AppleDouble + post-notarize state)');
    const verifier = steps[verifierIndex];

    expect(verifierIndex).toBeGreaterThan(rendererProbeIndex);
    expect(verifierIndex).toBeLessThan(repackIndex);
    expect(buildBundleRun.indexOf('npm run build')).toBeGreaterThanOrEqual(0);
    expect(buildBundleRun.indexOf('npm run verify:webserver-boot')).toBeGreaterThan(
      buildBundleRun.indexOf('npm run build'),
    );
    expect(buildBundleRun.indexOf('npm run tauri:prebuild-cleanup')).toBeGreaterThan(
      buildBundleRun.indexOf('npm run verify:webserver-boot'),
    );

    const publishJob = workflow.jobs?.['publish'];
    // 三平台折入后 publish 同时依赖 mac + windows，但 windows 失败不拖死 mac 发版：
    // if 条件只要求 build-mac 成功（windows 缺席由 merge/stable 步骤降级处理）
    expect(publishJob?.needs).toEqual(['build-mac', 'build-windows']);
    expect(publishJob?.if).toBe("${{ always() && needs.build-mac.result == 'success' }}");
    const publishStepNames = (publishJob?.steps ?? []).map((step) => step.name);
    expect(publishStepNames).toContain('Create GitHub Release');
    expect(publishStepNames.indexOf('Merge per-arch updater manifests (single latest.json, all platforms)'))
      .toBeLessThan(publishStepNames.indexOf('Create GitHub Release'));

    // windows job 自身的 fail-closed 链：资源验证 → renderer 探针 → NSIS 构建 → 产物验证 →
    // 重命名（最终 OSS key 名）→ manifest 生成（URL 与对象名一致的前提）
    const windowsSteps = (workflow.jobs?.['build-windows']?.steps ?? []).map((step) => step.name);
    const winPreIndex = windowsSteps.indexOf('Verify bundle resources (pre)');
    const winProbeIndex = windowsSteps.indexOf('Smoke-probe renderer startup');
    const winBuildIndex = windowsSteps.indexOf('Build NSIS bundle (unsigned, minisign updater artifacts)');
    const winPostIndex = windowsSteps.indexOf('Verify NSIS artifact (post)');
    const winRenameIndex = windowsSteps.indexOf('Rename installer to final OSS key name');
    const winManifestIndex = windowsSteps.indexOf('Generate per-platform updater manifest (points to OSS)');
    expect(winPreIndex).toBeGreaterThanOrEqual(0);
    expect(winProbeIndex).toBeGreaterThan(winPreIndex);
    expect(winBuildIndex).toBeGreaterThan(winProbeIndex);
    expect(winPostIndex).toBeGreaterThan(winBuildIndex);
    expect(winRenameIndex).toBeGreaterThan(winPostIndex);
    expect(winManifestIndex).toBeGreaterThan(winRenameIndex);

    expect(verifier?.if).toBe("${{ matrix.arch == 'arm64' && !contains(github.ref_name, '-') }}");
    expect(verifier?.env).toMatchObject({
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS: '${{ secrets.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS }}',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: '${{ secrets.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY }}',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE: '${{ secrets.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE }}',
      CONTROL_PLANE_SMOKE_TOKEN: '${{ secrets.CONTROL_PLANE_SMOKE_TOKEN }}',
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(verifier?.run).toContain('VERSION="${GITHUB_REF_NAME#v}"');
    expect(verifier?.run).toContain('npm run renderer:verify-release-gate --');
    expect(verifier?.run).toContain('--workflow renderer-bundle.yml');
    expect(verifier?.run).toContain('--head-sha "${GITHUB_SHA}"');
    expect(verifier?.run).toContain('--workflow-branch "${GITHUB_REF_NAME}"');
    expect(verifier?.run).toContain('--workflow-expected-conclusion success');
    expect(verifier?.run).toContain('--workflow-timeout-ms 1800000');
    expect(verifier?.run).toContain('--expected-version "${VERSION}"');
    expect(verifier?.run).toContain('--expected-release-channel latest');
    expect(verifier?.run).toContain('--retry-attempts 12');
    expect(verifier?.run).toContain('--retry-delay-ms 30000');
  });

  it('keeps renderer hot-update workflow able to publish signed rollback manifests', () => {
    const workflow = readRepoFile('.github/workflows/renderer-bundle.yml');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('tag push 不评估 paths filter');
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("'v*'");
    expect(workflow).toContain('renderer-capability-diff:');
    expect(workflow).toContain('renderer-hot-update-smoke:');
    expect(workflow).toContain('git worktree add --detach');
    expect(workflow).toContain('npm run renderer:capability-diff');
    expect(workflow).toContain('--summary-output "${GITHUB_STEP_SUMMARY}"');
    expect(workflow).toContain('--fail-on-unsupported');
    expect(workflow).toContain("'src/host/services/renderer/**'");
    expect(workflow).toContain("'src/host/services/cloud/controlPlaneTrust.ts'");
    expect(workflow).toContain("'src/host/ipc/update.ipc.ts'");
    expect(workflow).toContain("'src/web/routes/static.ts'");
    expect(workflow).toContain("'vercel-api/api/v1/control-plane.ts'");
    expect(workflow).toContain("'vercel-api/lib/controlPlanePayloads.ts'");
    expect(workflow).toContain("'vercel-api/lib/controlPlaneRendererRollout.ts'");
    expect(workflow).toContain("'scripts/control-plane-smoke.mjs'");
    expect(workflow).toContain("'scripts/control-plane-release-bundle.mjs'");
    expect(workflow).toContain("'scripts/generate-control-plane-env.mjs'");
    expect(workflow).toContain('scripts/verify-renderer-hot-update-production.mjs');
    expect(workflow).toContain('release_channel:');
    expect(workflow).toContain('target_cohort:');
    expect(workflow).toContain('控制面 rollout policy 可按 cohort 命中');
    expect(workflow).toContain('rollout_percent:');
    expect(workflow).toContain('dry_run:');
    expect(workflow).toContain('RENDERER_BUNDLE_DRY_RUN:');
    expect(workflow).toContain('CONTROL_PLANE_SMOKE_TOKEN:');
    expect(workflow).toContain('TAG_VERSION="${GITHUB_REF_NAME#v}"');
    expect(workflow).toContain('Renderer bundle version ${VERSION} does not match tag ${GITHUB_REF_NAME}.');
    expect(workflow).toContain('ARGS+=(--dry-run)');
    expect(workflow).toContain('Renderer bundle dry-run: generated candidate artifacts only');
    expect(workflow).toContain('renderer-bundle/channels/${RELEASE_CHANNEL}');
    expect(workflow).toContain('--channel "${RELEASE_CHANNEL}"');
    expect(workflow).toContain('--cohort "${TARGET_COHORT}"');
    expect(workflow).toContain('--rollout-percent "${ROLLOUT_PERCENT}"');
    expect(workflow).toContain('Summarize renderer manifest diff');
    expect(workflow).toContain('renderer-bundle-latest-manifest.json');
    expect(workflow).toContain('npm run renderer:manifest-diff');
    expect(workflow).toContain('Generate renderer release record');
    expect(workflow).toContain('npm run renderer:release-record');
    expect(workflow).toContain('release-record.json');
    expect(workflow).toContain('release-record.md');
    expect(workflow).toContain('Verify production renderer rollout control plane');
    expect(workflow).toContain('npm run renderer:verify-production -- --skip-renderer-bundle --retry-attempts 12 --retry-delay-ms 30000');
    expect(workflow).toContain('--release-record-url "${BUNDLE_BASE_URL}/release-record.json"');
    expect(workflow).toContain('--expected-release-channel "${RELEASE_CHANNEL}"');
    expect(workflow).toContain('--expected-cohort "${TARGET_COHORT}"');
    expect(workflow).toContain('--expected-rollout-percent "${ROLLOUT_PERCENT}"');
    expect(workflow).toContain('Verify production renderer hot-update surface');
    expect(workflow).toContain('PROD_ARGS=(');
    expect(workflow).toContain('--manifest-url "${BUNDLE_BASE_URL}/manifest.json"');
    expect(workflow).toContain('--retry-attempts 12');
    expect(workflow).toContain('--retry-delay-ms 30000');
    expect(workflow).toContain('npm run renderer:verify-production -- "${PROD_ARGS[@]}"');
    expect(workflow).toContain('rollback_to_builtin');
    expect(workflow).toContain('--rollback-to-builtin');
    expect(workflow).toContain('--rollback-reason');
    expect(workflow).toContain('Published renderer rollback manifest');
    expect(workflow).toContain('--allow-empty-required-shell-capabilities');
    expect(workflow).toContain('Smoke renderer hot-update serving');
    expect(workflow).toContain('npm run acceptance:renderer-hot-update');
    expect(workflow).toContain("env.RENDERER_BUNDLE_DRY_RUN != 'true'");
    expect(workflow).not.toContain('\t');
  });

  it('fails formal tag renderer publishes when signing material is incomplete', () => {
    const workflow = readWorkflow('.github/workflows/renderer-bundle.yml');
    const steps = workflow.jobs?.['publish-renderer-bundle']?.steps ?? [];
    const stepByName = (name: string) => steps.find((step) => step.name === name);
    const buildCondition = "${{ (env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY != '' && env.CODE_AGENT_CONTROL_PLANE_KEY_ID != '') || env.RENDERER_BUNDLE_DRY_RUN == 'true' }}";
    const publishCondition = "${{ env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY != '' && env.CODE_AGENT_CONTROL_PLANE_KEY_ID != '' && env.RENDERER_BUNDLE_DRY_RUN != 'true' }}";

    const guard = stepByName('Guard renderer signing material');
    expect(guard?.if).toBe("${{ (env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY == '' || env.CODE_AGENT_CONTROL_PLANE_KEY_ID == '') && env.RENDERER_BUNDLE_DRY_RUN != 'true' }}");
    expect(guard?.run).toContain('GITHUB_REF_TYPE');
    expect(guard?.run).toContain('Formal tag renderer bundle publish requires CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY and CODE_AGENT_CONTROL_PLANE_KEY_ID');
    expect(guard?.run).toContain('exit 1');
    expect(guard?.run).toContain('renderer bundle publishing is disabled for this non-tag run');

    for (const name of [
      'Checkout code',
      'Setup Node.js',
      'Install dependencies',
      'Build + sign renderer bundle',
      'Summarize renderer manifest diff',
      'Generate renderer release record',
      'Smoke renderer hot-update serving',
    ]) {
      expect(stepByName(name)?.if).toBe(buildCondition);
    }
    for (const name of [
      'Verify production renderer rollout control plane',
      'Install ossutil (Aliyun OSS CLI)',
      'Upload renderer bundle to Aliyun OSS',
      'Verify published renderer bundle',
      'Verify production renderer hot-update surface',
    ]) {
      expect(stepByName(name)?.if).toBe(publishCondition);
    }
  });

  it('keeps renderer hot-update PR and push path filters in sync', () => {
    const triggers = readWorkflowTriggers('.github/workflows/renderer-bundle.yml');
    const pullRequestPaths = triggers.pull_request.paths ?? [];
    const pushPaths = triggers.push.paths ?? [];
    const pushTags = triggers.push.tags ?? [];
    const onlyPullRequest = pullRequestPaths.filter((entry) => !pushPaths.includes(entry));
    const onlyPush = pushPaths.filter((entry) => !pullRequestPaths.includes(entry));
    const requiredProductionPaths = [
      'scripts/control-plane-smoke.mjs',
      'scripts/control-plane-release-bundle.mjs',
      'scripts/generate-control-plane-env.mjs',
      'vercel-api/api/v1/control-plane.ts',
      'vercel-api/lib/controlPlaneEnvelope.ts',
      'vercel-api/lib/controlPlanePayloads.ts',
      'vercel-api/lib/controlPlaneRendererRollout.ts',
      '.github/workflows/renderer-bundle.yml',
    ];

    expect(onlyPullRequest).toEqual([]);
    expect(onlyPush).toEqual([]);
    expect(pushTags).toContain('v*');
    for (const path of requiredProductionPaths) {
      expect(pullRequestPaths).toContain(path);
      expect(pushPaths).toContain(path);
    }
  });

  it('keeps control-plane and renderer hot-update scripts inside PR CI scope', () => {
    const workflow = readRepoFile('.github/workflows/swarm-ci.yml');
    const parsed = readWorkflow('.github/workflows/swarm-ci.yml');
    const smokeSteps = parsed.jobs?.smoke?.steps ?? [];
    const typecheckStep = smokeSteps.find((step) => step.name === 'Typecheck Vercel control-plane');

    expect(workflow).toContain("'.github/workflows/release.yml'");
    expect(workflow).toContain("'.github/workflows/renderer-bundle.yml'");
    expect(workflow).toContain("'.github/workflows/vercel-control-plane.yml'");
    expect(workflow).toContain("'vercel-api/**'");
    expect(workflow).toContain("'scripts/control-plane-*.mjs'");
    expect(workflow).toContain("'scripts/generate-control-plane-env.mjs'");
    expect(workflow).toContain("'scripts/renderer-*.mjs'");
    expect(workflow).toContain("'scripts/verify-github-workflow-run.mjs'");
    expect(workflow).toContain("'scripts/verify-renderer-bundle-publish.mjs'");
    expect(workflow).toContain("'scripts/verify-renderer-hot-update-production.mjs'");
    expect(workflow).toContain("'scripts/verify-renderer-hot-update-release-gate.mjs'");
    expect(workflow).toContain("'scripts/verify-runtime-assets-publish.mjs'");
    expect(workflow).toContain("'supabase/migrations/**'");
    expect(typecheckStep?.run).toContain('npm ci --prefix vercel-api --ignore-scripts');
    expect(typecheckStep?.run).toContain('npm --prefix vercel-api run typecheck');
    expect(workflow).not.toContain('\t');
  });

  it('keeps Vercel control-plane deployment automated and smoke-checked', () => {
    const workflowText = readRepoFile('.github/workflows/vercel-control-plane.yml');
    const workflow = readWorkflow('.github/workflows/vercel-control-plane.yml');
    const triggers = readWorkflowTriggers('.github/workflows/vercel-control-plane.yml');
    const steps = workflow.jobs?.deploy?.steps ?? [];
    const stepByName = (name: string) => steps.find((step) => step.name === name);

    expect(triggers.push.tags).toBeUndefined();
    expect(triggers.push.paths).toEqual(expect.arrayContaining([
      'vercel-api/**',
      'scripts/control-plane-*.mjs',
      'scripts/generate-control-plane-env.mjs',
      'scripts/verify-renderer-hot-update-production.mjs',
      '.github/workflows/vercel-control-plane.yml',
    ]));
    expect(triggers.workflow_dispatch).toBeDefined();

    expect(workflowText).toContain('VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}');
    expect(workflowText).toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}');
    expect(workflowText).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(workflowText).toContain('CONTROL_PLANE_PRODUCTION_URL: https://agentneo.vercel.app');
    expect(stepByName('Validate Vercel deploy secrets')?.run).toContain('Missing required Vercel deploy secret');
    expect(stepByName('Typecheck Vercel control-plane')?.run).toContain('npm ci --prefix vercel-api --ignore-scripts');
    expect(stepByName('Typecheck Vercel control-plane')?.run).toContain('npm --prefix vercel-api run typecheck');
    expect(stepByName('Install Vercel CLI')?.run).toBe('npm install -g vercel@latest');
    expect(stepByName('Pull Vercel production environment')?.run).toBe('vercel pull --yes --environment=production --token="${VERCEL_TOKEN}"');
    expect(stepByName('Assert Vercel project binding')?.run).toContain(".vercel/project.json");
    expect(stepByName('Assert Vercel project binding')?.run).toContain('project.orgId !== process.env.VERCEL_ORG_ID');
    expect(stepByName('Assert Vercel project binding')?.run).toContain('project.projectId !== process.env.VERCEL_PROJECT_ID');
    expect(stepByName('Assert Vercel project binding')?.run).toContain("project.settings.rootDirectory !== 'vercel-api'");
    expect(stepByName('Build Vercel control-plane')?.run).toBe('vercel build --prod --token="${VERCEL_TOKEN}"');
    expect(stepByName('Assert Vercel build output')?.run).toContain('api/v1/control-plane');
    expect(stepByName('Assert Vercel build output')?.run).toContain('controlPlaneRendererRollout.js');
    expect(stepByName('Assert Vercel build output')?.run).toContain('vercel-api/api/v1/control-plane.js');
    expect(stepByName('Assert Vercel build output')?.run).toContain('routed handler file');
    expect(stepByName('Assert Vercel build output')?.run).toContain("config.handler !== 'vercel-api/api/v1/control-plane.js'");
    expect(stepByName('Deploy Vercel control-plane')?.run).toBe('vercel deploy --prebuilt --prod --token="${VERCEL_TOKEN}"');
    expect(stepByName('Smoke production control-plane')?.run).toContain('node scripts/control-plane-smoke.mjs "${CONTROL_PLANE_PRODUCTION_URL}"');
    expect(workflowText).not.toContain('\t');
  });

  it('keeps runtime asset archives free of unsupported link entries', () => {
    const builder = readRepoFile('scripts/build-runtime-assets.mjs');

    expect(builder).toContain('entry.isSymbolicLink()');
    expect(builder).toContain("relativePath === 'node_modules/.bin'");
    expect(builder).toContain("relativePath.endsWith('/node_modules/.bin')");
  });

  it('wires package release scripts through notarize and verify gates', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      version: string;
      scripts: Record<string, string>;
    };
    const packageLock = JSON.parse(readRepoFile('package-lock.json')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };
    const prebuildCleanup = readRepoFile('scripts/tauri-prebuild-cleanup.sh');
    const releaseBundle = readRepoFile('scripts/tauri-release-bundle.sh');
    const releaseNeo = readRepoFile('scripts/release-neo.sh');
    const prepareBundledNode = readRepoFile('scripts/prepare-bundled-node.mjs');

    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.['']?.version).toBe(packageJson.version);
    expect(packageJson.scripts['release:neo']).toBe('bash scripts/release-neo.sh');
    expect(packageJson.scripts['desktop-shell:packaged-smoke']).toBe('node scripts/desktop-shell-packaged-smoke.mjs');
    expect(packageJson.scripts['release:post-publish']).toBe('node scripts/release-post-publish-verify.mjs');
    expect(packageJson.scripts['tauri:package']).toContain('npm run build && npm run verify:webserver-boot && npm run tauri:prebuild-cleanup');
    expect(packageJson.scripts['tauri:package:dev']).toContain('npm run build && npm run verify:webserver-boot && npm run tauri:prebuild-cleanup');
    expect(packageJson.scripts['tauri:release:bundle']).toContain('bash scripts/tauri-release-bundle.sh');
    expect(packageJson.scripts['tauri:release:bundle']).toContain('npm run build && npm run verify:webserver-boot && npm run tauri:prebuild-cleanup');
    expect(packageJson.scripts['tauri:release:bundle']).toContain('npm run release:notarize-macos');
    expect(packageJson.scripts['tauri:release:bundle']).toContain('npm run release:verify-macos');
    expect(packageJson.scripts['release:notarize-macos']).toBe('bash scripts/tauri-notarize.sh');
    expect(packageJson.scripts['release:verify-macos']).toBe('bash scripts/verify-macos-release.sh');
    expect(packageJson.scripts['renderer:verify-production']).toBe('npx tsx scripts/verify-renderer-hot-update-production.mjs');
    expect(packageJson.scripts['renderer:verify-release-gate']).toBe('npx tsx scripts/verify-renderer-hot-update-release-gate.mjs');
    expect(releaseNeo).toContain('git push "${REMOTE}" main');
    expect(releaseNeo).toContain('git push "${REMOTE}" "${TAG}"');
    expect(releaseNeo).toContain('node scripts/verify-github-workflow-run.mjs');
    expect(releaseNeo).toContain('--post-publish-verify');
    expect(releaseNeo).toContain('--desktop-shell-diagnostics-file');
    expect(releaseNeo).toContain('--require-desktop-shell-diagnostics');
    expect(releaseNeo).toContain('local post_publish_cmd=(npm run release:post-publish -- --version "${VERSION}")');
    expect(releaseNeo).toContain('if ((${#POST_PUBLISH_ARGS[@]} > 0)); then');
    expect(releaseNeo).toContain('post_publish_cmd+=("${POST_PUBLISH_ARGS[@]}")');
    expect(releaseNeo).toContain('run_gate "post-publish production verification" "${post_publish_cmd[@]}"');
    expect(releaseNeo).toContain('npm run release:security-scan');
    expect(releaseNeo).toContain('tests/scripts/verifyProductionEnv.test.ts');
    expect(releaseNeo).toContain('tests/scripts/releaseMacosGates.test.ts');
    expect(prebuildCleanup).toContain('stage-cua-driver-resource.sh');
    expect(prebuildCleanup).toContain('prepare-bundled-node.mjs');
    expect(releaseBundle).toContain('prepare-bundled-node.mjs');
    expect(releaseBundle).toContain('*/dist/bundled-node/bin/node');
    expect(prepareBundledNode).toContain("execFileSync('xattr', ['-cr', outputRoot]");
    expect(prepareBundledNode).toContain('rewriteFileWithoutExtendedAttributes(outputBin, 0o755)');
  });

  it('bundles Sharp runtime while keeping optional browser and audio runtimes out of Tauri resources', () => {
    const { sources } = readTauriResources();

    expect(sources.some((resource) => resource.includes('node_modules/onnxruntime-node'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/onnxruntime-common'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/avr-vad'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/playwright'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/playwright-core'))).toBe(false);

    expect(sources).toContain('../node_modules/sharp/package.json');
    expect(sources).toContain('../node_modules/sharp/lib/*.js');
    expect(sources).toContain('../node_modules/sharp/node_modules/semver');
    expect(sources).toContain('../node_modules/@img/colour/package.json');
    expect(sources).toContain('../node_modules/@img/colour/*.cjs');
    expect(sources).toContain('../node_modules/@img/sharp-darwin-arm64/package.json');
    expect(sources).toContain('../node_modules/@img/sharp-darwin-arm64/lib');
    expect(sources).toContain('../node_modules/@img/sharp-libvips-darwin-arm64/package.json');
    expect(sources).toContain('../node_modules/@img/sharp-libvips-darwin-arm64/versions.json');
    expect(sources).toContain('../node_modules/@img/sharp-libvips-darwin-arm64/lib');
    expect(sources).toContain('../node_modules/detect-libc/package.json');
    expect(sources).toContain('../node_modules/detect-libc/lib');
    expect(sources.some((resource) => resource.includes('node_modules/sharp/src'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/sharp/install'))).toBe(false);
    expect(sources.some((resource) => resource.endsWith('index.d.ts'))).toBe(false);
  });

  it('stages the CUA helper from a noindex source while preserving its packaged app path', () => {
    const { sources, targets, map } = readTauriResources();
    const fetchCuaDriver = readRepoFile('scripts/fetch-cua-driver.sh');
    const stageCuaDriver = readRepoFile('scripts/stage-cua-driver-resource.sh');
    const cleanBundleApps = readRepoFile('scripts/tauri-clean-bundle-apps.sh');
    const gitignore = readRepoFile('.gitignore');

    expect(sources).toContain('../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app');
    expect(map['../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app']).toBe('scripts/Agent Neo Computer Use.app');
    expect(targets).toContain('scripts/Agent Neo Computer Use.app');
    expect(sources).not.toContain('../scripts/Agent Neo Computer Use.app');
    expect(sources.some((resource) => resource.startsWith('../scripts/Agent Neo Computer Use.app'))).toBe(false);

    expect(fetchCuaDriver).toContain('.tauri-resources.noindex');
    expect(stageCuaDriver).toContain('LEGACY_APP');
    expect(stageCuaDriver).toContain('rm -rf "${LEGACY_APP}"');
    expect(cleanBundleApps).toContain('Agent Neo Computer Use');
    expect(cleanBundleApps).toContain('*/_up_/scripts/${HELPER_APP_NAME}.app');
    expect(gitignore).toContain('.tauri-resources.noindex/');
  });

  it('removes the macOS-only CUA helper from the Windows Tauri resource overlay', () => {
    const result = spawnSync('node', ['scripts/tauri-platform-config.mjs', 'win32-x64'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const overlay = JSON.parse(result.stdout) as { bundle?: { resources?: TauriResources } };
    const resources = overlay.bundle?.resources ?? {};
    expect(Array.isArray(resources)).toBe(false);
    const resourcePatch = resources as Record<string, string | null>;
    const baseResources = readTauriResources().map;
    const merged = applyResourceMergePatch(baseResources, resourcePatch);
    const sources = Object.keys(merged);
    const targets = Object.values(merged);

    expect(resourcePatch['../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app']).toBeNull();
    expect(resourcePatch['../node_modules/@img/sharp-darwin-arm64/package.json']).toBeNull();
    expect(resourcePatch['../node_modules/@img/sharp-libvips-darwin-arm64/package.json']).toBeNull();
    expect(sources.some((resource) => resource.includes('Agent Neo Computer Use.app'))).toBe(false);
    expect(targets.some((resource) => resource.includes('Agent Neo Computer Use.app'))).toBe(false);
    expect(sources.some((resource) => resource.includes('sharp-darwin-arm64'))).toBe(false);
    expect(sources.some((resource) => resource.includes('sharp-libvips-darwin-arm64'))).toBe(false);
    expect(sources).toContain('../node_modules/@img/sharp-win32-x64/package.json');
    expect(sources).toContain('../node_modules/@img/sharp-win32-x64/lib');
    expect(sources).toContain('../scripts/rtk.exe');
    expect(targets).toContain('scripts/rtk.exe');
  });

  it('replaces arm64 native resources in the macOS x64 Tauri resource overlay', () => {
    const result = spawnSync('node', ['scripts/tauri-arch-config.mjs', 'x64'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const overlay = JSON.parse(result.stdout) as { bundle?: { resources?: TauriResources } };
    const resources = overlay.bundle?.resources ?? {};
    expect(Array.isArray(resources)).toBe(false);
    const resourcePatch = resources as Record<string, string | null>;
    const merged = applyResourceMergePatch(readTauriResources().map, resourcePatch);
    const sources = Object.keys(merged);
    const targets = Object.values(merged);

    expect(resourcePatch['../node_modules/@img/sharp-darwin-arm64/package.json']).toBeNull();
    expect(resourcePatch['../node_modules/@img/sharp-libvips-darwin-arm64/package.json']).toBeNull();
    expect(sources.some((resource) => resource.includes('darwin-arm64'))).toBe(false);
    expect(targets.some((resource) => resource.includes('darwin-arm64'))).toBe(false);
    expect(sources).toContain('../node_modules/node-pty/prebuilds/darwin-x64');
    expect(sources).toContain('../node_modules/@img/sharp-darwin-x64/package.json');
    expect(sources).toContain('../node_modules/@img/sharp-libvips-darwin-x64/package.json');
    expect(merged['../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app'])
      .toBe('scripts/Agent Neo Computer Use.app');
  });

  it('keeps default runtime asset downloads limited to optional browser and audio components', () => {
    const builder = readRepoFile('scripts/build-runtime-assets.mjs');
    const defaultAssets = builder.match(/const DEFAULT_RUNTIME_ASSET_IDS = \[([\s\S]*?)\];/)?.[1] ?? '';

    expect(defaultAssets).toContain("'onnxruntime-vad'");
    expect(defaultAssets).toContain("'playwright-browser-runtime'");
    expect(defaultAssets).not.toContain('sharp-image-runtime');
  });

  it('writes runtime asset metadata into stable release JSON when publish URLs are provided', () => {
    const output = resolve(mkdtempSync(`${tmpdir()}/stable-release-json-`), 'release.json');
    const result = spawnSync('node', [
      'scripts/build-stable-release-json.mjs',
      '--version',
      '0.16.93',
      '--tag',
      'v0.16.93',
      '--dmg-url',
      'https://oss.example/v0.16.93/Agent-Neo-0.16.93-arm64.dmg',
      '--html-url',
      'https://github.com/acme/code-agent/releases/tag/v0.16.93',
      '--runtime-assets-manifest-url',
      'https://oss.example/v0.16.93/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      '--runtime-assets-manifest-sha-url',
      'https://oss.example/v0.16.93/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      '--output',
      output,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const release = JSON.parse(readFileSync(output, 'utf8')) as {
      assets: Array<{ name: string; browser_download_url: string }>;
    };
    expect(release.assets).toEqual(expect.arrayContaining([
      {
        name: 'runtime-assets-manifest-darwin-arm64.json',
        browser_download_url: 'https://oss.example/v0.16.93/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      },
      {
        name: 'runtime-assets-manifest-darwin-arm64.sha256',
        browser_download_url: 'https://oss.example/v0.16.93/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      },
    ]));
  });

  it('keeps better-sqlite3 source and build inputs out of default Tauri resources', () => {
    const { sources } = readTauriResources();

    expect(sources).toContain('../node_modules/better-sqlite3/package.json');
    expect(sources).toContain('../node_modules/better-sqlite3/lib');
    expect(sources).toContain('../node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    expect(sources.some((resource) => resource.includes('node_modules/better-sqlite3/deps'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/better-sqlite3/src'))).toBe(false);
    expect(sources.some((resource) => resource === '../node_modules/better-sqlite3')).toBe(false);
  });

  it('keeps node-pty runtime resources free of source maps, typings, and tests', () => {
    const { sources } = readTauriResources();

    expect(sources).toContain('../node_modules/node-pty/package.json');
    expect(sources).toContain('../node_modules/node-pty/lib/index.js');
    expect(sources).toContain('../node_modules/node-pty/lib/unixTerminal.js');
    expect(sources).toContain('../node_modules/node-pty/prebuilds/darwin-arm64');

    expect(sources.some((resource) => resource.includes('node_modules/node-pty/lib/**/*'))).toBe(false);
    expect(sources.some((resource) => resource.includes('node_modules/node-pty/typings'))).toBe(false);
    expect(sources.some((resource) => resource.endsWith('.map'))).toBe(false);
    expect(sources.some((resource) => resource.includes('.test.'))).toBe(false);
  });

  it('bundles the prepared Node runtime in default Tauri resources', () => {
    const { sources } = readTauriResources();

    expect(sources).toContain('../dist/bundled-node');
  });
});
