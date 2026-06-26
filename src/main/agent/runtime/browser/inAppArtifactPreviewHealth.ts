import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Route } from 'playwright';
import { ARTIFACT_PREVIEW_HEALTH } from '../../../../shared/constants/previewHealth';
import { WEB_SERVER_DEFAULTS } from '../../../../shared/constants/webServer';
import { CONFIG_DIR_NEW } from '../../../../shared/constants/configDir';
import { formatPreviewHealthMessage } from '../../../../shared/i18n/previewHealth';
import { createLogger } from '../../../services/infra/logger';
import { getBrowserService } from '../../../services/infra/browserPool';
import type { BrowserService } from '../../../services/infra/browserService';
import {
  collectArtifactPreviewHealthDiagnosticsFromPage,
  normalizeArtifactPreviewHealthDiagnostics,
  type ArtifactPreviewHealthOptions,
} from './artifactPreviewHealthProbe';
import {
  evaluateArtifactPreviewHealthDiagnostics,
} from './artifactPreviewHealthEvaluator';
import type { ArtifactPreviewHealthSummary } from './artifactPreviewHealth';

const logger = createLogger('ArtifactPreviewHealth');

export interface InAppArtifactPreviewHealthOptions extends ArtifactPreviewHealthOptions {
  browserService?: Pick<BrowserService, 'withIsolatedPage'>;
}

export class InAppArtifactPreviewHealthUnavailableError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly checks: string[] = [],
  ) {
    super(message);
    this.name = 'InAppArtifactPreviewHealthUnavailableError';
  }
}

export interface WebServerAccess {
  baseUrl: string;
  token: string;
  artifactUrl: string;
  redactedArtifactUrl: string;
  syntheticResourceBasePath: string;
}

function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveWebServerBaseUrl(options: InAppArtifactPreviewHealthOptions): string {
  if (options.webServerBaseUrl?.trim()) {
    return normalizeBaseUrl(options.webServerBaseUrl.trim());
  }
  const host = process.env.WEB_HOST || WEB_SERVER_DEFAULTS.HOST;
  const port = process.env.WEB_PORT || String(WEB_SERVER_DEFAULTS.PORT);
  return `http://${host}:${port}`;
}

function resolveTokenCandidatePaths(): string[] {
  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim()
    ? path.resolve(process.env.CODE_AGENT_DATA_DIR.trim())
    : path.join(process.env.HOME || '', CONFIG_DIR_NEW);
  return [
    path.join(process.cwd(), WEB_SERVER_DEFAULTS.DEV_AUTH_TOKEN_FILE),
    path.join(dataDir, WEB_SERVER_DEFAULTS.DEV_AUTH_TOKEN_FILE),
  ];
}

async function readWebServerToken(options: InAppArtifactPreviewHealthOptions): Promise<string> {
  const explicit = options.webServerToken?.trim();
  if (explicit) return explicit;

  for (const candidate of resolveTokenCandidatePaths()) {
    try {
      const token = (await readFile(candidate, 'utf8')).trim();
      if (token) return token;
    } catch {
      // Try the next candidate; missing token means this runtime is likely CLI/headless.
    }
  }
  throw new InAppArtifactPreviewHealthUnavailableError(
    'webserver_token_missing',
    'webServer auth token is missing',
  );
}

export function buildWorkspaceFileUrl(baseUrl: string, filePath: string, token: string): string {
  const url = new URL(WEB_SERVER_DEFAULTS.WORKSPACE_FILE_PATH, normalizeBaseUrl(baseUrl));
  url.searchParams.set('path', filePath);
  url.searchParams.set('token', token);
  return url.href;
}

export function redactPreviewHealthUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '[redacted]');
    }
    return url.href;
  } catch {
    return value.replace(/([?&]token=)[^&]+/g, '$1[redacted]');
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function assertWebServerHealthy(baseUrl: string, filePath: string, locale?: string | null): Promise<void> {
  const healthUrl = new URL(WEB_SERVER_DEFAULTS.HEALTH_PATH, baseUrl).href;
  let response: Response;
  try {
    response = await fetchWithTimeout(healthUrl, ARTIFACT_PREVIEW_HEALTH.WEB_SERVER_HEALTH_TIMEOUT_MS);
  } catch (error) {
    throw new InAppArtifactPreviewHealthUnavailableError(
      'webserver_health_unreachable',
      formatPreviewHealthMessage('webServerUnavailable', { reason: error instanceof Error ? error.message : String(error) }, locale),
    );
  }

  let payload: { status?: unknown; serverRoot?: unknown } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    // Non-JSON health is treated as unavailable.
  }
  if (!response.ok || payload.status !== 'ok') {
    throw new InAppArtifactPreviewHealthUnavailableError(
      'webserver_health_not_ok',
      formatPreviewHealthMessage('webServerUnavailable', { reason: `health status ${response.status}` }, locale),
    );
  }

  const serverRoot = typeof payload.serverRoot === 'string' ? path.resolve(payload.serverRoot) : null;
  const resolvedFile = path.resolve(filePath);
  const fileAllowed = (serverRoot && isPathWithinBase(resolvedFile, serverRoot))
    || isPathWithinBase(resolvedFile, path.resolve(tmpdir()));
  if (!fileAllowed) {
    throw new InAppArtifactPreviewHealthUnavailableError(
      'workspace_file_outside_webserver_roots',
      formatPreviewHealthMessage('webServerUnavailable', { reason: 'workspace file route would reject this artifact path' }, locale),
    );
  }
}

async function assertWorkspaceFileReachable(access: WebServerAccess, locale?: string | null): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(access.artifactUrl, ARTIFACT_PREVIEW_HEALTH.WEB_SERVER_FILE_TIMEOUT_MS);
  } catch (error) {
    throw new InAppArtifactPreviewHealthUnavailableError(
      'workspace_file_unreachable',
      formatPreviewHealthMessage('webServerUnavailable', { reason: error instanceof Error ? error.message : String(error) }, locale),
      [`workspace file url: ${access.redactedArtifactUrl}`],
    );
  } finally {
    // The artifact is only preflighted here; the browser will load it for real below.
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new InAppArtifactPreviewHealthUnavailableError(
      'workspace_file_not_ok',
      formatPreviewHealthMessage('webServerUnavailable', { reason: `workspace file status ${response.status}` }, locale),
      [`workspace file url: ${access.redactedArtifactUrl}`],
    );
  }
}

async function resolveWebServerAccess(
  filePath: string,
  options: InAppArtifactPreviewHealthOptions,
): Promise<WebServerAccess> {
  const baseUrl = resolveWebServerBaseUrl(options);
  await assertWebServerHealthy(baseUrl, filePath, options.locale);
  const token = await readWebServerToken(options);
  const artifactUrl = buildWorkspaceFileUrl(baseUrl, filePath, token);
  const access = {
    baseUrl,
    token,
    artifactUrl,
    redactedArtifactUrl: redactPreviewHealthUrl(artifactUrl),
    syntheticResourceBasePath: path.posix.dirname(WEB_SERVER_DEFAULTS.WORKSPACE_FILE_PATH),
  };
  await assertWorkspaceFileReachable(access, options.locale);
  return access;
}

export function createWorkspaceResourceRoute(args: {
  artifactPath: string;
  access: WebServerAccess;
}): (route: Route) => Promise<boolean> {
  const artifactDir = path.dirname(path.resolve(args.artifactPath));
  const base = new URL(args.access.baseUrl);
  const syntheticBasePath = args.access.syntheticResourceBasePath;

  return async (route: Route): Promise<boolean> => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(route.request().url());
    } catch {
      return false;
    }

    if (requestUrl.origin !== base.origin) return false;
    if (requestUrl.pathname === WEB_SERVER_DEFAULTS.WORKSPACE_FILE_PATH) return false;
    const requestPath = decodeURIComponent(requestUrl.pathname);
    if (requestPath !== syntheticBasePath && !requestPath.startsWith(`${syntheticBasePath}/`)) {
      return false;
    }

    const relativeUrlPath = path.posix.relative(syntheticBasePath, requestPath);
    const resourcePath = path.resolve(artifactDir, relativeUrlPath);
    if (!isPathWithinBase(resourcePath, artifactDir)) return false;
    await route.continue({
      url: buildWorkspaceFileUrl(args.access.baseUrl, resourcePath, args.access.token),
    });
    return true;
  };
}

export function isInAppArtifactPreviewHealthUnavailable(error: unknown): error is InAppArtifactPreviewHealthUnavailableError {
  return error instanceof InAppArtifactPreviewHealthUnavailableError;
}

export async function runInAppArtifactPreviewHealth(
  filePath: string,
  options: InAppArtifactPreviewHealthOptions = {},
): Promise<ArtifactPreviewHealthSummary> {
  const timeoutMs = options.timeoutMs ?? ARTIFACT_PREVIEW_HEALTH.TIMEOUT_MS;
  const viewports = options.viewports?.length ? options.viewports : ARTIFACT_PREVIEW_HEALTH.VIEWPORTS;
  const initialViewport = viewports[0] ?? ARTIFACT_PREVIEW_HEALTH.VIEWPORTS[0];
  const mainElementSelectors = options.mainElementSelectors ?? ARTIFACT_PREVIEW_HEALTH.MAIN_ELEMENT_SELECTORS;
  const access = await resolveWebServerAccess(filePath, options);
  const browserService = options.browserService ?? getBrowserService(options.agentId);
  const checks: string[] = [
    `artifact preview health route=${ARTIFACT_PREVIEW_HEALTH.ROUTES.IN_APP_BROWSER}`,
    `workspace file url: ${access.redactedArtifactUrl}`,
  ];

  logger.info('Artifact preview health using in-app browser route', {
    route: ARTIFACT_PREVIEW_HEALTH.ROUTES.IN_APP_BROWSER,
    url: access.redactedArtifactUrl,
  });

  const diagnostics = await browserService.withIsolatedPage({
    viewport: { width: initialViewport.width, height: initialViewport.height },
    leaseOwner: 'artifact-preview-health',
    leaseTtlMs: ARTIFACT_PREVIEW_HEALTH.IN_APP_BROWSER_LEASE_TTL_MS,
    route: createWorkspaceResourceRoute({ artifactPath: filePath, access }),
    run: async (page) => normalizeArtifactPreviewHealthDiagnostics(
      await collectArtifactPreviewHealthDiagnosticsFromPage({
        page,
        url: access.artifactUrl,
        timeoutMs,
        viewports,
        mainElementSelectors,
      }),
      {
        artifactPath: filePath,
        webServerBaseUrl: access.baseUrl,
        syntheticResourceBasePath: access.syntheticResourceBasePath,
      },
    ),
  });

  const findings = evaluateArtifactPreviewHealthDiagnostics(diagnostics);
  checks.unshift(formatPreviewHealthMessage(
    findings.length === 0 ? 'routeInAppPassed' : 'routeInAppFindings',
    {},
    options.locale,
  ));
  checks.push(formatPreviewHealthMessage('inspectedViewports', { count: diagnostics.viewports.length }, options.locale));

  return {
    attempted: true,
    passed: findings.length === 0,
    findings,
    failures: findings.map((item) => item.message),
    checks,
    diagnostics,
    route: ARTIFACT_PREVIEW_HEALTH.ROUTES.IN_APP_BROWSER,
  };
}
