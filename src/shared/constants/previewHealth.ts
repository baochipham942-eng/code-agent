export const ARTIFACT_PREVIEW_HEALTH = {
  TIMEOUT_MS: 10_000,
  CDP_CONNECT_TIMEOUT_MS: 8_000,
  SETTLE_MS: 350,
  OVERFLOW_TOLERANCE_PX: 4,
  VISIBLE_ELEMENT_MIN_SIZE_PX: 4,
  STDERR_LIMIT: 12_000,
  VIEWPORTS: [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'wide-desktop', width: 1920, height: 1080 },
    { name: 'mobile', width: 390, height: 780 },
  ],
  MAIN_ELEMENT_SELECTORS: [
    '[data-preview-root]',
    '[data-artifact-root]',
    '[data-design-root]',
    'main',
    '[role="main"]',
    '#root',
    '#app',
  ],
} as const;

export type ArtifactPreviewHealthViewportName =
  (typeof ARTIFACT_PREVIEW_HEALTH.VIEWPORTS)[number]['name'];

export const ARTIFACT_PREVIEW_VISION = {
  TIMEOUT_MS: 30_000,
  MIN_CONFIDENCE: 0.45,
  MAX_FINDINGS: 8,
  SUBJECTIVE_FINDING_CODES: [
    'typography_issue',
    'hierarchy_issue',
    'occlusion_issue',
    'brand_consistency_issue',
  ],
} as const;

export type ArtifactPreviewVisionFindingCode =
  (typeof ARTIFACT_PREVIEW_VISION.SUBJECTIVE_FINDING_CODES)[number];
