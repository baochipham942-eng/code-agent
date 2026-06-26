import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ConsoleMessage, Page } from 'playwright';
import { ARTIFACT_PREVIEW_HEALTH } from '../../../../shared/constants/previewHealth';

export interface ArtifactPreviewHealthViewportDiagnostics {
  name: string;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  bodyTextLength: number;
  visibleElements: number;
  horizontalOverflow: boolean;
  mainElement: {
    present: boolean;
    selector?: string;
  };
  brokenImages: Array<{
    src: string;
    alt?: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
  }>;
}

export interface ArtifactPreviewHealthDiagnostics {
  title?: string;
  consoleErrors: string[];
  pageErrors: string[];
  viewports: ArtifactPreviewHealthViewportDiagnostics[];
}

export interface ArtifactPreviewHealthOptions {
  timeoutMs?: number;
  locale?: string | null;
  agentId?: string | null;
  webServerBaseUrl?: string;
  webServerToken?: string;
  mainElementSelectors?: readonly string[];
  viewports?: readonly { name: string; width: number; height: number }[];
}

export interface ArtifactPreviewHealthProbeRunOptions {
  page: Page;
  url: string;
  timeoutMs: number;
  mainElementSelectors: readonly string[];
  viewports: readonly { name: string; width: number; height: number }[];
}

export interface ArtifactPreviewDiagnosticsNormalizationOptions {
  artifactPath: string;
  webServerBaseUrl?: string;
  syntheticResourceBasePath?: string;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizePathEvidence(targetPath: string, artifactPath: string): string {
  const artifactDir = path.dirname(path.resolve(artifactPath));
  const relative = path.relative(artifactDir, path.resolve(targetPath));
  return `artifact-relative:${toPosixPath(relative || path.basename(targetPath))}`;
}

function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizeWorkspaceFileUrl(url: URL, artifactPath: string): string | null {
  const servedPath = url.searchParams.get('path');
  if (!servedPath) return null;
  return normalizePathEvidence(servedPath, artifactPath);
}

function normalizeSyntheticResourceUrl(
  url: URL,
  artifactPath: string,
  webServerBaseUrl: string | undefined,
  syntheticResourceBasePath: string | undefined,
): string | null {
  if (!webServerBaseUrl || !syntheticResourceBasePath) return null;

  let base: URL;
  try {
    base = new URL(webServerBaseUrl);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;

  const basePath = syntheticResourceBasePath.endsWith('/')
    ? syntheticResourceBasePath.slice(0, -1)
    : syntheticResourceBasePath;
  const requestPath = decodeURIComponent(url.pathname);
  if (requestPath !== basePath && !requestPath.startsWith(`${basePath}/`)) return null;
  const relativeUrlPath = path.posix.relative(basePath, requestPath);
  const artifactDir = path.dirname(path.resolve(artifactPath));
  const resolved = path.resolve(artifactDir, relativeUrlPath);
  if (!isPathWithinBase(resolved, artifactDir)) return null;
  return normalizePathEvidence(resolved, artifactPath);
}

export function normalizeArtifactPreviewResourceUrl(
  value: string,
  options: ArtifactPreviewDiagnosticsNormalizationOptions,
): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      return normalizePathEvidence(fileURLToPath(url), options.artifactPath);
    }
    const workspaceFile = normalizeWorkspaceFileUrl(url, options.artifactPath);
    if (workspaceFile) return workspaceFile;
    const synthetic = normalizeSyntheticResourceUrl(
      url,
      options.artifactPath,
      options.webServerBaseUrl,
      options.syntheticResourceBasePath,
    );
    if (synthetic) return synthetic;
    return value;
  } catch {
    return value;
  }
}

export function normalizeArtifactPreviewHealthDiagnostics(
  diagnostics: ArtifactPreviewHealthDiagnostics,
  options: ArtifactPreviewDiagnosticsNormalizationOptions,
): ArtifactPreviewHealthDiagnostics {
  return {
    ...diagnostics,
    viewports: diagnostics.viewports.map((viewport) => ({
      ...viewport,
      brokenImages: viewport.brokenImages.map((image) => ({
        ...image,
        src: normalizeArtifactPreviewResourceUrl(image.src, options),
      })),
    })),
  };
}

export function artifactFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export async function collectArtifactPreviewHealthDiagnosticsFromPage(
  options: ArtifactPreviewHealthProbeRunOptions,
): Promise<ArtifactPreviewHealthDiagnostics> {
  const { page, url, timeoutMs, viewports, mainElementSelectors } = options;
  const startedAt = Date.now();
  const remaining = () => Math.max(1200, timeoutMs - (Date.now() - startedAt));
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error) => {
    pageErrors.push(error.message);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    const viewportDiagnostics: ArtifactPreviewHealthViewportDiagnostics[] = [];
    let latestTitle = '';

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      await page.waitForTimeout(ARTIFACT_PREVIEW_HEALTH.SETTLE_MS);

      const probe = await page.evaluate(({ selectors, minVisibleSize, overflowTolerance }) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const documentElement = document.documentElement;
        const body = document.body;

        const visibleElements = [...document.body.querySelectorAll('*')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > minVisibleSize
              && rect.height > minVisibleSize
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && Number(style.opacity || '1') !== 0
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= viewport.height
              && rect.left <= viewport.width;
          })
          .length;

        let mainElementSelector: string | undefined;
        for (const selector of selectors) {
          try {
            const element = document.querySelector(selector);
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const visible = rect.width > minVisibleSize
              && rect.height > minVisibleSize
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && Number(style.opacity || '1') !== 0
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= viewport.height
              && rect.left <= viewport.width;
            if (visible) {
              mainElementSelector = selector;
              break;
            }
          } catch {
            // Invalid custom selectors are ignored; default selectors are static.
          }
        }

        const brokenImages = [...document.images]
          .filter((image) => image.naturalWidth === 0)
          .map((image) => ({
            src: image.currentSrc || image.src || '',
            alt: image.alt || undefined,
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
          }));

        return {
          title: document.title,
          viewport,
          documentWidth: documentElement.scrollWidth,
          documentHeight: documentElement.scrollHeight,
          bodyTextLength: body?.innerText?.trim().length || 0,
          visibleElements,
          horizontalOverflow: documentElement.scrollWidth > viewport.width + overflowTolerance,
          mainElement: {
            present: Boolean(mainElementSelector),
            selector: mainElementSelector,
          },
          brokenImages,
        };
      }, {
        selectors: [...mainElementSelectors],
        minVisibleSize: ARTIFACT_PREVIEW_HEALTH.VISIBLE_ELEMENT_MIN_SIZE_PX,
        overflowTolerance: ARTIFACT_PREVIEW_HEALTH.OVERFLOW_TOLERANCE_PX,
      });

      latestTitle = probe.title || latestTitle;
      viewportDiagnostics.push({
        name: viewport.name,
        width: probe.viewport.width,
        height: probe.viewport.height,
        documentWidth: probe.documentWidth,
        documentHeight: probe.documentHeight,
        bodyTextLength: probe.bodyTextLength,
        visibleElements: probe.visibleElements,
        horizontalOverflow: probe.horizontalOverflow,
        mainElement: probe.mainElement,
        brokenImages: probe.brokenImages,
      });
    }

    return {
      title: latestTitle,
      consoleErrors: consoleErrors.slice(0, 10),
      pageErrors: pageErrors.slice(0, 10),
      viewports: viewportDiagnostics,
    };
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}
