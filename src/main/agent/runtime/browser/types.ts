export interface BrowserVisualSmokeSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  failures: string[];
  checks: string[];
  diagnostics?: BrowserVisualSmokeDiagnostics;
}

export type BrowserInteractionAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'click-selector'; selector: string }
  | { type: 'hover'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number };

export interface BrowserInteractionExpect {
  textVisible?: string;
  textHidden?: string;
  selectorVisible?: string;
  selectorHidden?: string;
  nonblankCanvasMin?: number;
  timeoutMs?: number;
}

export interface BrowserInteractionStep {
  label?: string;
  viewport?: 'desktop' | 'mobile' | 'both';
  action: BrowserInteractionAction;
  expect?: BrowserInteractionExpect;
}

export interface BrowserInteractionStepResult {
  label?: string;
  viewport: string;
  action: BrowserInteractionAction;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  failures: string[];
  checks: string[];
}

export interface BrowserVisualSmokeOptions {
  timeoutMs?: number;
  interactions?: BrowserInteractionStep[];
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
    documentWidth?: number;
    documentHeight?: number;
    canvasCount: number;
    nonblankCanvasCount: number;
    visibleElements: number;
    horizontalOverflow: boolean;
    canvasFrames?: Array<{
      width: number;
      height: number;
      left: number;
      top: number;
      right: number;
      bottom: number;
      visibleRatio: number;
      internalWidth: number;
      internalHeight: number;
    }>;
  }>;
  interactions?: BrowserInteractionStepResult[];
}
