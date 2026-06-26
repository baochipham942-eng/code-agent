import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import {
  normalizeArtifactPreviewResourceUrl,
  normalizeArtifactPreviewHealthDiagnostics,
  type ArtifactPreviewHealthDiagnostics,
} from '../../../../../src/host/agent/runtime/browser/artifactPreviewHealthProbe';

const artifactPath = path.join('/tmp', 'preview-fixture', 'index.html');

describe('artifact preview health probe normalization', () => {
  it('normalizes file and in-app workspace resource URLs to artifact-relative evidence', () => {
    const fileUrl = pathToFileURL(path.join('/tmp', 'preview-fixture', 'assets', 'missing.png')).href;
    const workspaceFileUrl = new URL('/api/workspace/file', 'http://127.0.0.1:8180');
    workspaceFileUrl.searchParams.set('path', path.join('/tmp', 'preview-fixture', 'assets', 'missing.png'));
    workspaceFileUrl.searchParams.set('token', 'secret-token');
    const syntheticUrl = 'http://127.0.0.1:8180/api/workspace/nested/missing.png';

    const options = {
      artifactPath,
      webServerBaseUrl: 'http://127.0.0.1:8180',
      syntheticResourceBasePath: '/api/workspace',
    };

    expect(normalizeArtifactPreviewResourceUrl(fileUrl, options)).toBe('artifact-relative:assets/missing.png');
    expect(normalizeArtifactPreviewResourceUrl(workspaceFileUrl.href, options)).toBe('artifact-relative:assets/missing.png');
    expect(normalizeArtifactPreviewResourceUrl(syntheticUrl, options)).toBe('artifact-relative:nested/missing.png');
  });

  it('keeps non-synthetic and out-of-artifact URLs unchanged', () => {
    const options = {
      artifactPath,
      webServerBaseUrl: 'http://127.0.0.1:8180',
      syntheticResourceBasePath: '/api/workspace',
    };
    const nonSynthetic = 'http://127.0.0.1:8180/api/other/missing.png';
    const outsideArtifact = 'http://127.0.0.1:8180/api/workspace/%2e%2e/outside.png';

    expect(normalizeArtifactPreviewResourceUrl(nonSynthetic, options)).toBe(nonSynthetic);
    expect(normalizeArtifactPreviewResourceUrl(outsideArtifact, options)).toBe(outsideArtifact);
  });

  it('normalizes broken image sources inside diagnostics before findings are evaluated', () => {
    const diagnostics: ArtifactPreviewHealthDiagnostics = {
      title: 'fixture',
      consoleErrors: [],
      pageErrors: [],
      viewports: [
        {
          name: 'mobile',
          width: 390,
          height: 780,
          documentWidth: 390,
          documentHeight: 780,
          bodyTextLength: 20,
          visibleElements: 4,
          horizontalOverflow: false,
          mainElement: { present: true, selector: 'main' },
          brokenImages: [
            {
              src: 'http://127.0.0.1:8180/api/workspace/assets/missing.png',
              alt: 'missing',
              complete: true,
              naturalWidth: 0,
              naturalHeight: 0,
            },
          ],
        },
      ],
    };

    const normalized = normalizeArtifactPreviewHealthDiagnostics(diagnostics, {
      artifactPath,
      webServerBaseUrl: 'http://127.0.0.1:8180',
      syntheticResourceBasePath: '/api/workspace',
    });

    expect(normalized.viewports[0].brokenImages[0].src).toBe('artifact-relative:assets/missing.png');
  });
});
