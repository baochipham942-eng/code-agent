import { describe, expect, it } from 'vitest';
import {
  evaluateArtifactPreviewHealthDiagnostics,
  type ArtifactPreviewHealthDiagnostics,
} from '../../../../../src/host/agent/runtime/browser/artifactPreviewHealth';

function baseDiagnostics(overrides: Partial<ArtifactPreviewHealthDiagnostics> = {}): ArtifactPreviewHealthDiagnostics {
  return {
    title: 'Good artifact',
    consoleErrors: [],
    pageErrors: [],
    viewports: [
      {
        name: 'desktop',
        width: 1280,
        height: 720,
        documentWidth: 1280,
        documentHeight: 720,
        bodyTextLength: 24,
        visibleElements: 4,
        horizontalOverflow: false,
        mainElement: { present: true, selector: 'main' },
        brokenImages: [],
      },
      {
        name: 'mobile',
        width: 390,
        height: 780,
        documentWidth: 390,
        documentHeight: 780,
        bodyTextLength: 24,
        visibleElements: 4,
        horizontalOverflow: false,
        mainElement: { present: true, selector: 'main' },
        brokenImages: [],
      },
    ],
    ...overrides,
  };
}

describe('artifactPreviewHealth deterministic findings', () => {
  it('accepts a healthy artifact without false positives', () => {
    const findings = evaluateArtifactPreviewHealthDiagnostics(baseDiagnostics());

    expect(findings).toEqual([]);
  });

  it('flags objective binary preview failures without vision', () => {
    const diagnostics = baseDiagnostics({
      consoleErrors: ['seed console'],
      pageErrors: ['seed runtime'],
      viewports: [
        {
          name: 'desktop',
          width: 1280,
          height: 720,
          documentWidth: 1280,
          documentHeight: 720,
          bodyTextLength: 0,
          visibleElements: 2,
          horizontalOverflow: false,
          mainElement: { present: false },
          brokenImages: [
            {
              src: 'missing.png',
              alt: 'Missing',
              complete: true,
              naturalWidth: 0,
              naturalHeight: 0,
            },
          ],
        },
        {
          name: 'mobile',
          width: 390,
          height: 780,
          documentWidth: 900,
          documentHeight: 780,
          bodyTextLength: 0,
          visibleElements: 2,
          horizontalOverflow: true,
          mainElement: { present: false },
          brokenImages: [
            {
              src: 'missing.png',
              alt: 'Missing',
              complete: true,
              naturalWidth: 0,
              naturalHeight: 0,
            },
          ],
        },
      ],
    });

    const codes = evaluateArtifactPreviewHealthDiagnostics(diagnostics).map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      'blank_body_text',
      'horizontal_overflow',
      'console_error',
      'page_error',
      'broken_image',
      'missing_main_element',
    ]));
  });

  it('adds a responsive finding when only some viewports fail', () => {
    const diagnostics = baseDiagnostics({
      viewports: [
        {
          name: 'desktop',
          width: 1280,
          height: 720,
          documentWidth: 1280,
          documentHeight: 720,
          bodyTextLength: 18,
          visibleElements: 4,
          horizontalOverflow: false,
          mainElement: { present: true, selector: 'main' },
          brokenImages: [],
        },
        {
          name: 'mobile',
          width: 390,
          height: 780,
          documentWidth: 900,
          documentHeight: 780,
          bodyTextLength: 18,
          visibleElements: 4,
          horizontalOverflow: true,
          mainElement: { present: true, selector: 'main' },
          brokenImages: [],
        },
      ],
    });

    const findings = evaluateArtifactPreviewHealthDiagnostics(diagnostics);

    expect(findings.map((finding) => finding.code)).toContain('responsive_breakpoint_failure');
  });
});
