#!/usr/bin/env node

import fs from 'node:fs';

const SEVERITY_RANK = {
  info: 0,
  warning: 1,
  error: 2,
};

const SECRET_KEY_RE = /(authorization|cookie|password|secret|token|private[_-]?key|api[_-]?key)/i;
const SECRET_VALUE_RE = /\b(?:bearer\s+)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSeverity(value, fallback = 'warning') {
  return value === 'error' || value === 'warning' || value === 'info' ? value : fallback;
}

function maxSeverity(current, next) {
  return SEVERITY_RANK[next] > SEVERITY_RANK[current] ? next : current;
}

function statusFromSeverity(severity) {
  if (severity === 'error') return 'failed';
  if (severity === 'warning') return 'warning';
  return 'ok';
}

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_VALUE_RE, '[redacted]');
}

function sanitizeObject(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeObject(entry));
  if (!isRecord(value)) return sanitizeText(value);

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : sanitizeObject(entry);
  }
  return output;
}

function sourceIssueText(issue) {
  return `${issue?.code ?? ''} ${issue?.message ?? ''}`.toLowerCase();
}

function isPortOccupiedIssue(issue) {
  const text = sourceIssueText(issue);
  return text.includes('desktop-shell-port-occupied')
    || text.includes('eaddrinuse')
    || /\bport\s+\d+\s+.*in use\b/.test(text)
    || /端口\s*\d+.*占用/.test(issue?.message ?? '');
}

function isBootTokenMismatchIssue(issue) {
  const text = sourceIssueText(issue);
  return text.includes('boot-token-mismatch')
    || text.includes('matching boot token')
    || text.includes('boot token');
}

function pushIssue(issues, issue) {
  const severity = normalizeSeverity(issue.severity);
  const normalized = {
    severity,
    code: issue.code,
    title: issue.title,
    message: sanitizeText(issue.message),
    action: sanitizeText(issue.action),
    ...(issue.evidence ? { evidence: sanitizeObject(issue.evidence) } : {}),
  };
  issues.push(normalized);
}

function rendererFallbackIssue(renderer) {
  if (!isRecord(renderer)) {
    return {
      severity: 'warning',
      code: 'desktop_shell_renderer_status_missing',
      title: 'Renderer serve decision is missing',
      message: 'The desktop shell could not report whether it is serving the active or builtin renderer.',
      action: 'Open the desktop shell diagnostics card and inspect /api/health.rendererServe.',
    };
  }

  if (renderer.source === 'active' && renderer.reason === 'active-healthy') {
    return null;
  }

  if (renderer.source === 'static') {
    return {
      severity: 'info',
      code: 'desktop_shell_renderer_static_override',
      title: 'Renderer static override is active',
      message: 'The shell is serving a static renderer override.',
      action: 'Use this only for local verification; remove the override before release.',
      evidence: { reason: renderer.reason, serveDir: renderer.serveDir },
    };
  }

  if (renderer.source !== 'builtin') {
    return {
      severity: 'warning',
      code: 'desktop_shell_renderer_unexpected_source',
      title: 'Renderer source is unexpected',
      message: `The shell reported renderer source "${renderer.source ?? 'unknown'}".`,
      action: 'Check the renderer bundle cache and /api/health rendererServe payload.',
      evidence: { source: renderer.source, reason: renderer.reason },
    };
  }

  const reason = renderer.reason ?? 'unknown';
  const reasonAdvice = {
    'no-active-meta': {
      severity: 'info',
      message: 'No active hot-update bundle is installed, so the shell is using the builtin renderer.',
      action: 'This is acceptable on a fresh install; post-publish checks should still verify the production renderer rollout.',
    },
    'hot-update-disabled': {
      severity: 'warning',
      message: 'Hot-update serving is disabled and the shell fell back to the builtin renderer.',
      action: 'Confirm the rollback/disable flag is intentional, then re-enable hot update for the release channel.',
    },
    'invalid-active-meta': {
      severity: 'warning',
      message: 'The active renderer metadata is invalid and the shell fell back to the builtin renderer.',
      action: 'Clear the renderer bundle cache and re-run renderer production verification.',
    },
    'active-index-missing': {
      severity: 'warning',
      message: 'The active renderer bundle is missing index.html and the shell fell back to the builtin renderer.',
      action: 'Rebuild or re-publish the renderer bundle, then verify the bundle archive contents.',
    },
    'active-older-than-shell': {
      severity: 'warning',
      message: 'The active renderer bundle is older than the desktop shell and the shell fell back to builtin.',
      action: 'Publish a renderer bundle for the current shell version or let the builtin renderer remain active for this release.',
    },
  };
  const advice = reasonAdvice[reason] ?? {
    severity: 'warning',
    message: `The shell fell back to the builtin renderer for reason "${reason}".`,
    action: 'Inspect the renderer bundle cache and production rollout record.',
  };

  return {
    severity: advice.severity,
    code: 'desktop_shell_renderer_fallback',
    title: 'Renderer fell back to builtin',
    message: advice.message,
    action: advice.action,
    evidence: {
      reason,
      activeBundle: renderer.activeBundle ?? null,
      currentShellVersion: renderer.currentShellVersion,
      serveDir: renderer.serveDir,
    },
  };
}

function classifyResource(resource) {
  if (!isRecord(resource) || resource.status === 'present') return null;
  const required = resource.required === true;
  return {
    severity: required ? 'error' : 'warning',
    code: required ? 'desktop_shell_required_resource_missing' : 'desktop_shell_optional_resource_missing',
    title: required ? 'Required packaged resource is missing' : 'Optional packaged resource is missing',
    message: `${resource.label ?? resource.id ?? 'resource'} is ${resource.status ?? 'missing'}.`,
    action: required
      ? 'Rebuild the Tauri bundle and run npm run build:web && npm run verify:webserver-boot before packaging.'
      : 'Verify whether this optional sidecar/native module is expected for the release channel.',
    evidence: {
      id: resource.id,
      kind: resource.kind,
      status: resource.status,
      path: resource.path,
    },
  };
}

function classifyRuntimeAsset(asset) {
  if (!isRecord(asset) || asset.state !== 'missing') return null;
  const bundled = asset.delivery === 'bundled';
  return {
    severity: bundled ? 'error' : 'warning',
    code: 'desktop_shell_runtime_asset_missing',
    title: bundled ? 'Bundled runtime asset is missing' : 'Optional runtime asset is missing',
    message: `${asset.label ?? asset.id ?? 'runtime asset'} is missing.`,
    action: bundled
      ? 'Rebuild packaged runtime resources and run the macOS release verifier before publishing.'
      : 'Confirm first-use runtime asset download is available for this channel, or install runtime assets before smoke.',
    evidence: {
      id: asset.id,
      delivery: asset.delivery,
      state: asset.state,
      nodeModules: asArray(asset.nodeModules).map((module) => ({
        name: module?.name,
        exists: module?.exists,
        source: module?.source,
        path: module?.path,
      })),
    },
  };
}

function classifyUnknownSourceIssue(issue) {
  if (!isRecord(issue)) return null;
  if (isPortOccupiedIssue(issue) || isBootTokenMismatchIssue(issue)) return null;
  if (issue.code === 'desktop-shell-required-resource-missing' || issue.code === 'desktop-shell-optional-resource-missing') {
    return null;
  }
  return {
    severity: normalizeSeverity(issue.severity, 'warning'),
    code: String(issue.code ?? 'desktop_shell_source_issue').replace(/-/g, '_'),
    title: 'Desktop shell reported an issue',
    message: String(issue.message ?? issue.code ?? 'desktop shell issue'),
    action: issue.action,
    evidence: { sourceCode: issue.code },
  };
}

export function extractDesktopShellDiagnostics(value) {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === 1 && isRecord(value.app) && isRecord(value.boot)) return value;
  if (isRecord(value.diagnostics)) return extractDesktopShellDiagnostics(value.diagnostics);
  if (isRecord(value.desktopShell)) return extractDesktopShellDiagnostics(value.desktopShell);
  if (isRecord(value.data)) return extractDesktopShellDiagnostics(value.data);
  if (isRecord(value.payload)) return extractDesktopShellDiagnostics(value.payload);
  if (isRecord(value.evidence)) {
    return extractDesktopShellDiagnostics(value.evidence.desktopShell)
      ?? extractDesktopShellDiagnostics(value.evidence.desktopShellDiagnostics)
      ?? extractDesktopShellDiagnostics(value.evidence.ipcDiagnostics);
  }
  return null;
}

export function readDesktopShellDiagnosticsFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const diagnostics = extractDesktopShellDiagnostics(parsed);
  if (!diagnostics) {
    throw new Error(`Could not find DesktopShellDiagnostics payload in ${filePath}`);
  }
  return diagnostics;
}

export function classifyDesktopShellDiagnostics(diagnostics) {
  const issues = [];
  const payload = extractDesktopShellDiagnostics(diagnostics);
  if (!payload) {
    return {
      status: 'failed',
      summary: {
        schemaVersion: undefined,
        stage: 'unknown',
        webHealth: 'unknown',
        rendererSource: undefined,
        rendererReason: undefined,
        requiredResourcesMissing: 0,
        runtimeAssetsMissing: 0,
        diagnosticFile: undefined,
      },
      issues: [{
        severity: 'error',
        code: 'desktop_shell_diagnostics_missing',
        title: 'Desktop shell diagnostics are missing',
        message: 'No DesktopShellDiagnostics payload was found.',
        action: 'Run npm run desktop-shell:packaged-smoke against a packaged app and pass its JSON output to the verifier.',
      }],
    };
  }

  const sourceIssues = asArray(payload.issues);
  const boot = isRecord(payload.boot) ? payload.boot : {};
  const webServer = isRecord(payload.webServer) ? payload.webServer : {};
  const renderer = isRecord(payload.renderer) ? payload.renderer : null;
  const resources = asArray(payload.resources);
  const runtimeAssets = isRecord(payload.runtimeAssets) ? payload.runtimeAssets : null;
  const app = isRecord(payload.app) ? payload.app : {};

  if (sourceIssues.some(isPortOccupiedIssue)) {
    pushIssue(issues, {
      severity: 'error',
      code: 'desktop_shell_port_occupied',
      title: 'webServer port is occupied',
      message: `The desktop shell could not bind port ${app.webPort ?? boot.webPort ?? 'unknown'}.`,
      action: 'Stop the process using the desktop webServer port, then launch the packaged app again.',
      evidence: { port: app.webPort ?? boot.webPort },
    });
  }

  if (boot.healthMatchedBootToken === false || webServer.health === 'boot-token-mismatch' || sourceIssues.some(isBootTokenMismatchIssue)) {
    pushIssue(issues, {
      severity: 'error',
      code: 'desktop_shell_boot_token_mismatch',
      title: 'webServer boot token mismatch',
      message: 'The healthcheck reached a webServer process that did not match the current Tauri boot token.',
      action: 'Kill the stale webServer process on the configured port and restart the packaged app.',
      evidence: {
        port: app.webPort ?? boot.webPort,
        webServerPid: boot.webServerPid ?? webServer.pid,
        health: webServer.health,
      },
    });
  }

  if (webServer.health && webServer.health !== 'ok' && webServer.health !== 'boot-token-mismatch') {
    pushIssue(issues, {
      severity: webServer.health === 'unknown' ? 'warning' : 'error',
      code: 'desktop_shell_web_health_unreachable',
      title: 'webServer health is not ok',
      message: `The desktop webServer health status is "${webServer.health}".`,
      action: 'Inspect desktop-shell-boot-latest.json and the packaged webServer logs before publishing.',
      evidence: {
        url: webServer.url,
        health: webServer.health,
        errorMessage: webServer.errorMessage,
      },
    });
  }

  if (boot.stage === 'failed' && !issues.some((issue) => issue.severity === 'error')) {
    pushIssue(issues, {
      severity: 'error',
      code: 'desktop_shell_boot_failed',
      title: 'Desktop shell boot failed',
      message: 'The boot diagnostics stage is failed.',
      action: 'Inspect the boot diagnostics JSON and fix the first recorded shell issue.',
      evidence: { diagnosticFile: boot.diagnosticFile },
    });
  }

  for (const resource of resources) {
    const issue = classifyResource(resource);
    if (issue) pushIssue(issues, issue);
  }

  const rendererIssue = rendererFallbackIssue(renderer);
  if (rendererIssue) pushIssue(issues, rendererIssue);

  if (!runtimeAssets) {
    pushIssue(issues, {
      severity: 'warning',
      code: 'desktop_shell_runtime_asset_status_missing',
      title: 'Runtime asset status is missing',
      message: 'The desktop shell diagnostics did not include runtime asset status.',
      action: 'Open the settings diagnostics card or run the packaged smoke again after startup settles.',
    });
  } else {
    const runtimeAssetIssues = asArray(runtimeAssets.assets)
      .map((asset) => classifyRuntimeAsset(asset))
      .filter(Boolean);
    for (const issue of runtimeAssetIssues) pushIssue(issues, issue);
    if (runtimeAssetIssues.length === 0 && Number(runtimeAssets.summary?.missing ?? 0) > 0) {
      pushIssue(issues, {
        severity: 'warning',
        code: 'desktop_shell_runtime_asset_missing',
        title: 'Runtime asset summary reports missing assets',
        message: `${runtimeAssets.summary.missing} runtime asset(s) are missing.`,
        action: 'Inspect runtimeAssets.assets for the missing component before publishing.',
        evidence: { summary: runtimeAssets.summary },
      });
    }
  }

  for (const sourceIssue of sourceIssues) {
    const issue = classifyUnknownSourceIssue(sourceIssue);
    if (issue) pushIssue(issues, issue);
  }

  let topSeverity = 'info';
  for (const issue of issues) {
    topSeverity = maxSeverity(topSeverity, issue.severity);
  }

  return {
    status: statusFromSeverity(topSeverity),
    summary: {
      schemaVersion: payload.schemaVersion,
      appVersion: app.version,
      mode: app.mode,
      stage: boot.stage ?? 'unknown',
      port: app.webPort ?? boot.webPort,
      webServerPid: boot.webServerPid ?? webServer.pid,
      webHealth: webServer.health ?? 'unknown',
      healthMatchedBootToken: boot.healthMatchedBootToken,
      rendererSource: renderer?.source,
      rendererReason: renderer?.reason,
      requiredResourcesMissing: resources.filter((resource) => resource?.required === true && resource.status !== 'present').length,
      optionalResourcesMissing: resources.filter((resource) => resource?.required !== true && resource.status !== 'present').length,
      runtimeAssetsMissing: Number(runtimeAssets?.summary?.missing ?? 0),
      diagnosticFile: boot.diagnosticFile,
    },
    issues,
  };
}

export function assertNoSensitiveDesktopShellDiagnostics(value) {
  const serialized = JSON.stringify(sanitizeObject(value));
  if (/(CODE_AGENT_TAURI_BOOT_TOKEN|authorization|bearer\s+[0-9a-f-]{36})/i.test(serialized)) {
    throw new Error('desktop shell diagnostics output contains sensitive auth material');
  }
}

export function desktopShellDiagnosticsFailureMessage(classification) {
  const issues = asArray(classification?.issues).filter((issue) => issue.severity === 'error');
  if (issues.length === 0) return undefined;
  return issues.map((issue) => `[${issue.code}] ${issue.message} Action: ${issue.action}`).join('\n');
}
