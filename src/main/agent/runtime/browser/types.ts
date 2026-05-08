export interface BrowserVisualSmokeSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  failures: string[];
  checks: string[];
  diagnostics?: BrowserVisualSmokeDiagnostics;
}

export interface BrowserVisualSmokeDiagnostics {
  title?: string;
  metaPresent?: boolean;
  testPresent?: boolean;
  canvasCount?: number;
  nonblankCanvasCount?: number;
  visibleElements?: number;
  bodyTextLength?: number;
  consoleErrors?: string[];
  pageErrors?: string[];
  computerUseFallback?: {
    screenshotPath?: string;
    screenshotBytes?: number;
    frontmostApp?: string | null;
    windowTitle?: string | null;
    reason?: string;
  };
  viewports?: Array<{
    name: string;
    width: number;
    height: number;
    canvasCount: number;
    nonblankCanvasCount: number;
    visibleElements: number;
    horizontalOverflow: boolean;
  }>;
}
