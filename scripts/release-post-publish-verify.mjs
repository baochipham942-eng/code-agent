#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  classifyDesktopShellDiagnostics,
  extractDesktopShellDiagnostics,
} from './desktop-shell-diagnostics.mjs';

export class ReleasePostPublishVerificationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ReleasePostPublishVerificationError';
    this.code = options.code ?? 'release_post_publish_verification_failed';
    this.failures = options.failures ?? [];
    this.warnings = options.warnings ?? [];
    this.summary = options.summary;
  }
}

const DEFAULT_BASE_URL = 'https://agentneo.vercel.app';
const DEFAULT_RENDERER_MANIFEST_URL = 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json';
const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVersion(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/^v/i, '')
    : undefined;
}

function assertVersion(value, label) {
  const version = normalizeVersion(value);
  if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
    throw new ReleasePostPublishVerificationError(`${label} must be a semver version`, {
      code: 'invalid_version',
      failures: [{ code: 'invalid_version', label, value }],
    });
  }
  return version;
}

function buildUrl(baseUrl, pathname, params = {}) {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function deriveReleaseRecordUrl(manifestUrl) {
  const url = new URL(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, '/release-record.json');
  return url.toString();
}

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ReleasePostPublishVerificationError(`Timed out fetching ${url}`, {
        code: 'fetch_timeout',
        failures: [{ code: 'fetch_timeout', url, timeoutMs }],
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(fetchImpl, url, init = {}, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
  return {
    ok: response.ok,
    status: response.status,
    url,
    headers: response.headers,
    text: await response.text(),
  };
}

async function fetchJson(fetchImpl, url, init = {}, timeoutMs) {
  const response = await fetchText(fetchImpl, url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  }, timeoutMs);
  let body;
  try {
    body = response.text.trim() ? JSON.parse(response.text) : undefined;
  } catch {
    return { ...response, body: undefined, textSample: response.text.slice(0, 500) };
  }
  return { ...response, body };
}

function pushFailure(failures, code, message, details = {}) {
  failures.push({ code, message, ...details });
}

function pushWarning(warnings, code, message, details = {}) {
  warnings.push({ code, message, ...details });
}

function releaseNotesLength(body) {
  const notes = body?.releaseNotes ?? body?.notes;
  return typeof notes === 'string' ? notes.trim().length : 0;
}

function readEnvelopePayload(body) {
  if (isRecord(body?.payload)) return body.payload;
  return {};
}

function summarizeEnvelope(body) {
  const payload = readEnvelopePayload(body);
  return {
    kind: typeof body?.kind === 'string' ? body.kind : undefined,
    keyId: typeof body?.keyId === 'string' ? body.keyId : undefined,
    version: normalizeVersion(payload.version),
    rollbackToBuiltin: payload.rollbackToBuiltin === true,
    manifestUrl: typeof payload.manifestUrl === 'string' ? payload.manifestUrl : undefined,
    bundleUrl: typeof payload.bundleUrl === 'string' ? payload.bundleUrl : undefined,
  };
}

function checkExpectedVersion(failures, label, actual, expectedVersion) {
  const normalizedActual = normalizeVersion(actual);
  if (normalizedActual !== expectedVersion) {
    pushFailure(failures, 'version_mismatch', `${label} version ${normalizedActual ?? 'missing'} does not match ${expectedVersion}`, {
      label,
      expectedVersion,
      actualVersion: normalizedActual,
    });
  }
}

function checkHttpOk(failures, label, response) {
  if (!response.ok) {
    pushFailure(failures, 'http_status', `${label} returned HTTP ${response.status}`, {
      label,
      status: response.status,
      url: response.url,
    });
    return false;
  }
  return true;
}

async function verifyAppUpdate({ fetchImpl, baseUrl, expectedVersion, requireCloudApiMetadata, timeoutMs }) {
  const failures = [];
  const warnings = [];
  const checkUrl = buildUrl(baseUrl, '/api/update', {
    action: 'check',
    version: '0.0.0',
    platform: 'darwin',
    channel: 'stable',
  });
  const healthUrl = buildUrl(baseUrl, '/api/update', { action: 'health' });

  const update = await fetchJson(fetchImpl, checkUrl, {}, timeoutMs);
  if (checkHttpOk(failures, 'app update check', update) && isRecord(update.body)) {
    checkExpectedVersion(failures, 'app update latestVersion', update.body.latestVersion, expectedVersion);
    if (releaseNotesLength(update.body) === 0) {
      pushFailure(failures, 'missing_release_notes', 'app update check returned empty release notes', { url: checkUrl });
    }
  }

  const health = await fetchJson(fetchImpl, healthUrl, {}, timeoutMs);
  if (checkHttpOk(failures, 'app update health', health) && isRecord(health.body)) {
    const source = typeof health.body.source === 'string' ? health.body.source : undefined;
    const metadataSource = source ?? health.body.updateSource ?? health.body.metadataSource;
    if (metadataSource === 'github_releases') {
      const message = 'Cloud API update metadata is falling back to GitHub Releases';
      if (requireCloudApiMetadata) {
        pushFailure(failures, 'cloud_api_metadata_fallback', message, { url: healthUrl, source: metadataSource });
      } else {
        pushWarning(warnings, 'cloud_api_metadata_fallback', message, { url: healthUrl, source: metadataSource });
      }
    }
  }

  return {
    summary: {
      update: {
        url: checkUrl,
        status: update.status,
        latestVersion: normalizeVersion(update.body?.latestVersion),
        releaseNotesLength: releaseNotesLength(update.body),
        source: update.body?.source,
      },
      health: {
        url: healthUrl,
        status: health.status,
        source: health.body?.source ?? health.body?.updateSource ?? health.body?.metadataSource,
      },
    },
    failures,
    warnings,
  };
}

async function verifyDownloadRedirects({ fetchImpl, baseUrl, expectedVersion, timeoutMs }) {
  const failures = [];
  const variants = [
    ['darwin-arm64', { action: 'download', platform: 'darwin', channel: 'stable' }],
    ['darwin-x64', { action: 'download', platform: 'darwin', channel: 'stable', arch: 'x64' }],
  ];
  const summary = [];
  for (const [label, params] of variants) {
    const url = buildUrl(baseUrl, '/api/update', params);
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { Accept: '*/*' },
    }, timeoutMs);
    const location = response.headers?.get?.('location') ?? undefined;
    summary.push({ label, url, status: response.status, location });
    if (response.status < 300 || response.status >= 400 || !location) {
      pushFailure(failures, 'download_redirect_missing', `${label} download did not return a redirect`, {
        label,
        status: response.status,
        url,
      });
      continue;
    }
    if (!location.includes(`v${expectedVersion}`) && !location.includes(expectedVersion)) {
      pushFailure(failures, 'download_redirect_version_mismatch', `${label} download redirect does not include ${expectedVersion}`, {
        label,
        location,
        expectedVersion,
      });
    }
  }
  return { summary, failures, warnings: [] };
}

async function verifyDistributionPage({ fetchImpl, baseUrl, expectedVersion, timeoutMs }) {
  const failures = [];
  const warnings = [];
  const url = buildUrl(baseUrl, '/code-agent/');
  const page = await fetchText(fetchImpl, url, { headers: { Accept: 'text/html' } }, timeoutMs);
  const hasVersionSlot = page.text.includes('id="download-version"');
  const hasUpdateProbe = page.text.includes('/api/update?action=check');
  if (checkHttpOk(failures, 'distribution page', page)) {
    if (!hasVersionSlot) {
      pushFailure(failures, 'missing_distribution_page_version_slot', 'distribution page has no visible download version slot', { url });
    }
    if (!/最新版本|Latest version/i.test(page.text)) {
      pushFailure(failures, 'missing_distribution_page_version_label', 'distribution page has no visible version label', { url });
    }
    if (!hasUpdateProbe) {
      pushFailure(failures, 'missing_distribution_page_update_probe', 'distribution page does not fetch update metadata for visible version', { url });
    }
    if (hasVersionSlot && hasUpdateProbe && !page.text.includes(expectedVersion)) {
      pushWarning(warnings, 'distribution_page_version_is_dynamic', 'distribution page version is rendered from /api/update at runtime, not embedded in static HTML', {
        url,
        expectedVersion,
      });
    }
  }
  return {
    summary: {
      url,
      status: page.status,
      hasVersionSlot,
      hasUpdateProbe,
    },
    failures,
    warnings,
  };
}

async function verifyRendererAndControlPlane({ fetchImpl, baseUrl, manifestUrl, releaseRecordUrl, expectedVersion, timeoutMs }) {
  const failures = [];
  const controlPlaneUrl = buildUrl(baseUrl, '/api/v1/control-plane', { artifact: 'renderer_bundle_rollout' });
  const controlPlane = await fetchJson(fetchImpl, controlPlaneUrl, {}, timeoutMs);
  const controlPlaneEnvelope = isRecord(controlPlane.body) ? summarizeEnvelope(controlPlane.body) : {};
  if (checkHttpOk(failures, 'control-plane renderer rollout', controlPlane)) {
    if (controlPlaneEnvelope.kind !== 'renderer_bundle_rollout') {
      pushFailure(failures, 'control_plane_kind_mismatch', 'control-plane renderer rollout returned the wrong envelope kind', {
        expectedKind: 'renderer_bundle_rollout',
        actualKind: controlPlaneEnvelope.kind,
        url: controlPlaneUrl,
      });
    }
    checkExpectedVersion(failures, 'control-plane renderer rollout', controlPlaneEnvelope.version, expectedVersion);
    if (controlPlaneEnvelope.rollbackToBuiltin) {
      pushFailure(failures, 'control_plane_renderer_rollback_enabled', 'control-plane renderer rollout is set to rollbackToBuiltin', {
        url: controlPlaneUrl,
        version: controlPlaneEnvelope.version,
      });
    }
  }

  const manifest = await fetchJson(fetchImpl, manifestUrl, {}, timeoutMs);
  const manifestEnvelope = isRecord(manifest.body) ? summarizeEnvelope(manifest.body) : {};
  if (checkHttpOk(failures, 'renderer latest manifest', manifest)) {
    if (manifestEnvelope.kind !== 'renderer_bundle') {
      pushFailure(failures, 'renderer_manifest_kind_mismatch', 'renderer latest manifest returned the wrong envelope kind', {
        expectedKind: 'renderer_bundle',
        actualKind: manifestEnvelope.kind,
        url: manifestUrl,
      });
    }
    checkExpectedVersion(failures, 'renderer latest manifest', manifestEnvelope.version, expectedVersion);
    if (manifestEnvelope.rollbackToBuiltin) {
      pushFailure(failures, 'renderer_manifest_rollback_enabled', 'renderer latest manifest is set to rollbackToBuiltin', {
        url: manifestUrl,
        version: manifestEnvelope.version,
      });
    }
  }

  const releaseRecord = await fetchJson(fetchImpl, releaseRecordUrl, {}, timeoutMs);
  if (checkHttpOk(failures, 'renderer release-record', releaseRecord) && isRecord(releaseRecord.body)) {
    checkExpectedVersion(failures, 'renderer release-record', releaseRecord.body.version, expectedVersion);
    if (releaseRecord.body.rollbackToBuiltin === true) {
      pushFailure(failures, 'renderer_release_record_rollback_enabled', 'renderer release-record is set to rollbackToBuiltin', {
        url: releaseRecordUrl,
        version: releaseRecord.body.version,
      });
    }
  }

  return {
    summary: {
      controlPlane: {
        url: controlPlaneUrl,
        status: controlPlane.status,
        ...controlPlaneEnvelope,
      },
      rendererManifest: {
        url: manifestUrl,
        status: manifest.status,
        ...manifestEnvelope,
      },
      releaseRecord: {
        url: releaseRecordUrl,
        status: releaseRecord.status,
        version: normalizeVersion(releaseRecord.body?.version),
        rollbackToBuiltin: releaseRecord.body?.rollbackToBuiltin === true,
      },
    },
    failures,
    warnings: [],
  };
}

export function auditServerLogs(raw) {
  const failures = [];
  const lines = String(raw ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const text = parsed ? JSON.stringify(parsed) : line;
    const level = String(
      parsed?.level ?? parsed?.severity ?? parsed?.type ?? parsed?.messageLevel ?? '',
    ).toLowerCase();
    const status = Number(
      parsed?.status
        ?? parsed?.statusCode
        ?? parsed?.responseStatusCode
        ?? parsed?.response?.status
        ?? parsed?.responseStatus,
    );
    const entry = { line: index + 1, sample: text.slice(0, 500) };
    if (Number.isFinite(status) && status >= 500) {
      pushFailure(failures, 'server_log_5xx', `server log line ${index + 1} contains HTTP ${status}`, {
        ...entry,
        status,
      });
    }
    if (/\bDEP0169\b/.test(text)) {
      pushFailure(failures, 'server_log_dep0169', `server log line ${index + 1} contains DEP0169 url.parse warning`, entry);
      continue;
    }
    if (['error', 'fatal', 'critical'].includes(level)) {
      pushFailure(failures, 'server_log_error_level', `server log line ${index + 1} is ${level}`, {
        ...entry,
        level,
      });
    }
  }
  return {
    checkedLines: lines.length,
    failures,
  };
}

async function verifyServerLogs({ logsFile, requireServerLogAudit }) {
  const warnings = [];
  if (!logsFile) {
    const message = 'server log audit skipped because --server-log-file was not provided';
    if (requireServerLogAudit) {
      return {
        summary: { checkedLines: 0, skipped: true },
        failures: [{ code: 'server_log_audit_missing', message }],
        warnings,
      };
    }
    pushWarning(warnings, 'server_log_audit_skipped', message);
    return { summary: { checkedLines: 0, skipped: true }, failures: [], warnings };
  }
  const raw = fs.readFileSync(logsFile, 'utf8');
  const result = auditServerLogs(raw);
  return {
    summary: { checkedLines: result.checkedLines, file: logsFile },
    failures: result.failures,
    warnings,
  };
}

async function verifyDesktopShellDiagnostics({ diagnosticsFile, requireDesktopShellDiagnostics }) {
  const warnings = [];
  if (!diagnosticsFile) {
    const message = 'desktop shell diagnostics skipped because --desktop-shell-diagnostics-file was not provided';
    if (requireDesktopShellDiagnostics) {
      return {
        summary: { skipped: true, status: 'missing' },
        failures: [{ code: 'desktop_shell_diagnostics_missing', message }],
        warnings,
      };
    }
    pushWarning(warnings, 'desktop_shell_diagnostics_skipped', message);
    return { summary: { skipped: true, status: 'skipped' }, failures: [], warnings };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(diagnosticsFile, 'utf8'));
  } catch (error) {
    return {
      summary: { file: diagnosticsFile, status: 'invalid-json' },
      failures: [{
        code: 'desktop_shell_diagnostics_file_invalid',
        message: `desktop shell diagnostics file is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
        file: diagnosticsFile,
      }],
      warnings,
    };
  }

  const diagnostics = extractDesktopShellDiagnostics(raw);
  const classification = classifyDesktopShellDiagnostics(diagnostics);
  const failures = [];
  const seenFailureCodes = new Set();
  const seenWarningCodes = new Set();
  const addFailure = (failure) => {
    const code = failure.code ?? 'desktop_shell_diagnostics_failed';
    const key = `${code}:${failure.message ?? ''}`;
    if (seenFailureCodes.has(key)) return;
    seenFailureCodes.add(key);
    failures.push({ code, message: failure.message, ...failure });
  };
  const addWarning = (code, message, details = {}) => {
    const key = `${code}:${message ?? ''}`;
    if (seenWarningCodes.has(key)) return;
    seenWarningCodes.add(key);
    pushWarning(warnings, code, message, details);
  };

  if (isRecord(raw) && raw.ok === false && Array.isArray(raw.failures)) {
    for (const failure of raw.failures) {
      if (isRecord(failure)) {
        addFailure({
          code: failure.code ?? 'desktop_shell_packaged_smoke_failed',
          message: failure.message ?? 'desktop shell packaged smoke failed',
          evidence: failure.evidence,
        });
      }
    }
  }

  for (const issue of classification.issues.filter((entry) => entry.severity === 'error')) {
    addFailure({
      code: issue.code,
      message: issue.message,
      action: issue.action,
      evidence: issue.evidence,
    });
  }

  for (const issue of classification.issues.filter((entry) => entry.severity === 'warning')) {
    addWarning(issue.code, issue.message, {
      action: issue.action,
      evidence: issue.evidence,
    });
  }
  if (isRecord(raw) && Array.isArray(raw.warnings)) {
    for (const warning of raw.warnings) {
      if (isRecord(warning)) {
        addWarning(warning.code ?? 'desktop_shell_packaged_smoke_warning', warning.message ?? 'desktop shell packaged smoke warning', {
          evidence: warning.evidence,
        });
      }
    }
  }

  return {
    summary: {
      file: diagnosticsFile,
      smokeOk: isRecord(raw) && typeof raw.ok === 'boolean' ? raw.ok : undefined,
      smokeSummary: isRecord(raw) && isRecord(raw.summary) ? raw.summary : undefined,
      status: classification.status,
      ...classification.summary,
      issueCount: classification.issues.length,
    },
    failures,
    warnings,
  };
}

function mergeResult(target, key, result) {
  target.summary[key] = result.summary;
  target.failures.push(...result.failures);
  target.warnings.push(...result.warnings);
}

export async function verifyReleasePostPublish(options = {}) {
  const expectedVersion = assertVersion(options.version, 'version');
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const manifestUrl = options.manifestUrl ?? DEFAULT_RENDERER_MANIFEST_URL;
  const releaseRecordUrl = options.releaseRecordUrl ?? deriveReleaseRecordUrl(manifestUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ReleasePostPublishVerificationError('fetch is not available in this Node.js runtime', {
      code: 'missing_fetch',
      failures: [{ code: 'missing_fetch' }],
    });
  }

  const result = { summary: {}, failures: [], warnings: [] };
  mergeResult(result, 'appUpdate', await verifyAppUpdate({
    fetchImpl,
    baseUrl,
    expectedVersion,
    requireCloudApiMetadata: options.requireCloudApiMetadata === true,
    timeoutMs,
  }));
  mergeResult(result, 'downloads', await verifyDownloadRedirects({
    fetchImpl,
    baseUrl,
    expectedVersion,
    timeoutMs,
  }));
  mergeResult(result, 'distributionPage', await verifyDistributionPage({
    fetchImpl,
    baseUrl,
    expectedVersion,
    timeoutMs,
  }));
  mergeResult(result, 'renderer', await verifyRendererAndControlPlane({
    fetchImpl,
    baseUrl,
    manifestUrl,
    releaseRecordUrl,
    expectedVersion,
    timeoutMs,
  }));
  mergeResult(result, 'serverLogs', await verifyServerLogs({
    logsFile: options.serverLogFile,
    requireServerLogAudit: options.requireServerLogAudit === true,
  }));
  mergeResult(result, 'desktopShell', await verifyDesktopShellDiagnostics({
    diagnosticsFile: options.desktopShellDiagnosticsFile,
    requireDesktopShellDiagnostics: options.requireDesktopShellDiagnostics === true,
  }));

  if (result.failures.length > 0) {
    throw new ReleasePostPublishVerificationError(
      result.failures.map((failure) => `[${failure.code}] ${failure.message}`).join('\n'),
      {
        failures: result.failures,
        warnings: result.warnings,
        summary: result.summary,
      },
    );
  }
  return result;
}

function readArg(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function createFixtureFetch(fixtureDir) {
  const readJsonResponse = (name, init = {}) => {
    const body = fs.readFileSync(path.join(fixtureDir, name), 'utf8');
    return new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  };
  const readTextResponse = (name, init = {}) => {
    const body = fs.readFileSync(path.join(fixtureDir, name), 'utf8');
    return new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': 'text/html', ...(init.headers ?? {}) },
    });
  };
  const readRedirect = (name) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
    return new Response('', {
      status: fixture.status ?? 302,
      headers: fixture.headers ?? {},
    });
  };

  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/update' && parsed.searchParams.get('action') === 'check') {
      return readJsonResponse('app-update.json');
    }
    if (parsed.pathname === '/api/update' && parsed.searchParams.get('action') === 'health') {
      return readJsonResponse('update-health.json');
    }
    if (parsed.pathname === '/api/update' && parsed.searchParams.get('action') === 'download') {
      return readRedirect(parsed.searchParams.get('arch') === 'x64'
        ? 'download-darwin-x64.json'
        : 'download-darwin-arm64.json');
    }
    if (parsed.pathname === '/code-agent/' || parsed.pathname === '/code-agent') {
      return readTextResponse('distribution-page.html');
    }
    if (parsed.pathname === '/api/v1/control-plane') {
      return readJsonResponse('control-plane-renderer-rollout.json');
    }
    if (parsed.pathname.endsWith('/manifest.json')) {
      return readJsonResponse('renderer-manifest.json');
    }
    if (parsed.pathname.endsWith('/release-record.json')) {
      return readJsonResponse('renderer-release-record.json');
    }
    return new Response(JSON.stringify({ error: 'fixture_not_found', url: String(url), method: init.method }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function usage() {
  return [
    'Usage: npm run release:post-publish -- --version 0.17.1',
    '',
    'Options:',
    '  --version <v>                    Expected released version',
    '  --base-url <url>                 Default: https://agentneo.vercel.app',
    '  --manifest-url <url>             Renderer latest manifest URL',
    '  --release-record-url <url>       Renderer release-record URL',
    '  --server-log-file <file>         Vercel log export to audit for 5xx/error/DEP0169',
    '  --desktop-shell-diagnostics-file <file>',
    '                                  JSON from npm run desktop-shell:packaged-smoke -- --json',
    '  --require-server-log-audit       Fail if --server-log-file is missing',
    '  --require-desktop-shell-diagnostics',
    '                                  Fail if desktop shell diagnostics JSON is missing',
    '  --require-cloud-api-metadata     Fail when update health is using github_releases fallback',
    '  --fixture-dir <dir>              Read responses from fixture files instead of network',
    '  --timeout-ms <n>                 Default: 15000',
    '  --json                          Print JSON summary',
  ].join('\n');
}

function parseCliArgs(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    return { help: true };
  }
  const packageVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    } catch {
      return undefined;
    }
  })();
  const fixtureDir = readArg(args, '--fixture-dir');
  const fixtureDesktopShellDiagnosticsFile = (() => {
    if (!fixtureDir) return undefined;
    for (const name of ['desktop-shell-smoke.json', 'desktop-shell-diagnostics.json']) {
      const file = path.join(fixtureDir, name);
      if (fs.existsSync(file)) return file;
    }
    return undefined;
  })();
  return {
    version: readArg(args, '--version') ?? packageVersion,
    baseUrl: readArg(args, '--base-url') ?? DEFAULT_BASE_URL,
    manifestUrl: readArg(args, '--manifest-url') ?? DEFAULT_RENDERER_MANIFEST_URL,
    releaseRecordUrl: readArg(args, '--release-record-url'),
    serverLogFile: readArg(args, '--server-log-file') ?? (
      fixtureDir && fs.existsSync(path.join(fixtureDir, 'server-logs.ndjson'))
        ? path.join(fixtureDir, 'server-logs.ndjson')
        : undefined
    ),
    desktopShellDiagnosticsFile: readArg(args, '--desktop-shell-diagnostics-file') ?? fixtureDesktopShellDiagnosticsFile,
    requireServerLogAudit: hasFlag(args, '--require-server-log-audit'),
    requireDesktopShellDiagnostics: hasFlag(args, '--require-desktop-shell-diagnostics'),
    requireCloudApiMetadata: hasFlag(args, '--require-cloud-api-metadata'),
    fixtureDir,
    timeoutMs: Number(readArg(args, '--timeout-ms') ?? DEFAULT_TIMEOUT_MS),
    json: hasFlag(args, '--json'),
    fetchImpl: fixtureDir ? createFixtureFetch(fixtureDir) : globalThis.fetch,
  };
}

function printHuman(result) {
  for (const [name, summary] of Object.entries(result.summary)) {
    process.stdout.write(`[release-post-publish] ok ${name}: ${JSON.stringify(summary)}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`[release-post-publish][warn] ${warning.message}\n`);
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    const result = await verifyReleasePostPublish(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    } else {
      printHuman(result);
    }
  } catch (error) {
    if (options.json && error instanceof ReleasePostPublishVerificationError) {
      process.stdout.write(JSON.stringify({
        ok: false,
        code: error.code,
        failures: error.failures,
        warnings: error.warnings,
        summary: error.summary,
      }, null, 2));
      process.stdout.write('\n');
    } else {
      process.stderr.write(`[release-post-publish][FAIL] ${error instanceof Error ? error.message : String(error)}\n`);
      if (error?.warnings?.length) {
        for (const warning of error.warnings) {
          process.stderr.write(`[release-post-publish][warn] ${warning.message}\n`);
        }
      }
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main();
}
