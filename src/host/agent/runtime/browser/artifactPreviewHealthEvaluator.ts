import type {
  ArtifactPreviewHealthDiagnostics,
  ArtifactPreviewHealthViewportDiagnostics,
} from './artifactPreviewHealthProbe';

export type ArtifactPreviewHealthFindingCode =
  | 'blank_body_text'
  | 'horizontal_overflow'
  | 'console_error'
  | 'page_error'
  | 'broken_image'
  | 'missing_main_element'
  | 'responsive_breakpoint_failure';

export interface ArtifactPreviewHealthFinding {
  code: ArtifactPreviewHealthFindingCode;
  message: string;
  viewport?: string;
  evidence?: Record<string, boolean | number | string | string[]>;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function createArtifactPreviewHealthFinding(
  code: ArtifactPreviewHealthFindingCode,
  message: string,
  viewport?: string,
  evidence?: ArtifactPreviewHealthFinding['evidence'],
): ArtifactPreviewHealthFinding {
  return {
    code,
    message,
    ...(viewport ? { viewport } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function evaluateArtifactPreviewHealthDiagnostics(
  diagnostics: ArtifactPreviewHealthDiagnostics,
): ArtifactPreviewHealthFinding[] {
  const findings: ArtifactPreviewHealthFinding[] = [];
  const viewportFindingCodes = new Map<string, Set<ArtifactPreviewHealthFindingCode>>();

  const addViewportFinding = (
    viewport: ArtifactPreviewHealthViewportDiagnostics,
    code: ArtifactPreviewHealthFindingCode,
    message: string,
    evidence?: ArtifactPreviewHealthFinding['evidence'],
  ) => {
    findings.push(createArtifactPreviewHealthFinding(code, message, viewport.name, evidence));
    const codes = viewportFindingCodes.get(viewport.name) ?? new Set<ArtifactPreviewHealthFindingCode>();
    codes.add(code);
    viewportFindingCodes.set(viewport.name, codes);
  };

  for (const viewport of diagnostics.viewports) {
    if (viewport.bodyTextLength === 0) {
      addViewportFinding(
        viewport,
        'blank_body_text',
        `${viewport.name} preview body text is empty.`,
        { bodyTextLength: viewport.bodyTextLength },
      );
    }

    if (viewport.horizontalOverflow) {
      addViewportFinding(
        viewport,
        'horizontal_overflow',
        `${viewport.name} preview overflows horizontally.`,
        {
          viewportWidth: viewport.width,
          documentWidth: viewport.documentWidth,
        },
      );
    }

    if (viewport.brokenImages.length > 0) {
      addViewportFinding(
        viewport,
        'broken_image',
        `${viewport.name} preview contains broken image(s).`,
        {
          count: viewport.brokenImages.length,
          src: viewport.brokenImages.slice(0, 3).map((image) => image.src),
        },
      );
    }

    if (!viewport.mainElement.present) {
      addViewportFinding(
        viewport,
        'missing_main_element',
        `${viewport.name} preview is missing a visible main artifact element.`,
        { visibleElements: viewport.visibleElements },
      );
    }
  }

  for (const error of uniqueStrings(diagnostics.consoleErrors).slice(0, 5)) {
    findings.push(createArtifactPreviewHealthFinding('console_error', `Preview console error: ${error}`, undefined, { text: error }));
  }

  for (const error of uniqueStrings(diagnostics.pageErrors).slice(0, 5)) {
    findings.push(createArtifactPreviewHealthFinding('page_error', `Preview runtime page error: ${error}`, undefined, { text: error }));
  }

  const viewportSpecificCodes = new Set<ArtifactPreviewHealthFindingCode>();
  for (const code of ['blank_body_text', 'horizontal_overflow', 'broken_image', 'missing_main_element'] as const) {
    const affectedViewports = diagnostics.viewports
      .filter((viewport) => viewportFindingCodes.get(viewport.name)?.has(code))
      .map((viewport) => viewport.name);
    if (affectedViewports.length > 0 && affectedViewports.length < diagnostics.viewports.length) {
      viewportSpecificCodes.add(code);
    }
  }
  if (viewportSpecificCodes.size > 0) {
    const failingViewportNames = diagnostics.viewports
      .filter((viewport) => {
        const codes = viewportFindingCodes.get(viewport.name);
        return codes && [...viewportSpecificCodes].some((code) => codes.has(code));
      })
      .map((viewport) => viewport.name);
    const healthyViewportNames = diagnostics.viewports
      .filter((viewport) => !failingViewportNames.includes(viewport.name))
      .map((viewport) => viewport.name);
    findings.push(createArtifactPreviewHealthFinding(
      'responsive_breakpoint_failure',
      `Preview health differs by viewport; failing viewport(s): ${failingViewportNames.join(', ')}.`,
      undefined,
      {
        failingViewports: failingViewportNames,
        healthyViewports: healthyViewportNames,
        viewportSpecificCodes: [...viewportSpecificCodes],
      },
    ));
  }

  return findings;
}
