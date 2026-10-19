export const ARTIFACT_PREVIEW_HEALTH = {
  TIMEOUT_MS: 10_000,
  CDP_CONNECT_TIMEOUT_MS: 8_000,
  WEB_SERVER_HEALTH_TIMEOUT_MS: 1_500,
  WEB_SERVER_FILE_TIMEOUT_MS: 2_000,
  IN_APP_BROWSER_LEASE_TTL_MS: 60_000,
  SETTLE_MS: 350,
  /** button_no_response 探针：点击后等 DOM mutation / innerText 变化 / 滚动位移的窗口 */
  BUTTON_CLICK_SETTLE_MS: 600,
  /**
   * button_no_response 探针 scroll 臂的位移门槛（px）：window 或按钮最近可滚动祖先
   * 在 settle 窗口内的最大绝对位移 ≥ 此值即算 responded（锚点导航常只滚动不碰 DOM）。
   */
  BUTTON_CLICK_SCROLL_DELTA_PX: 2,
  OVERFLOW_TOLERANCE_PX: 4,
  VISIBLE_ELEMENT_MIN_SIZE_PX: 4,
  STDERR_LIMIT: 12_000,
  ROUTES: {
    IN_APP_BROWSER: 'in-app-browser',
    SELF_STARTED_CHROME: 'self-started-chrome',
  },
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

export const DESIGN_PREVIEW_REPAIR = {
  VERSION: 1,
  MAX_ATTEMPTS: 2,
  MAX_FINDINGS: 16,
  MAX_PROMPT_CHARS: 10_000,
} as const;
