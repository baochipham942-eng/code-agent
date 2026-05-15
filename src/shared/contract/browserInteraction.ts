/**
 * 浏览器交互验证的共享类型定义。
 *
 * 两个执行路径共用同一份 step DSL：
 * - main 进程的 visualSmoke（Playwright headless 路径）
 * - renderer 端的 in-app validation panel（iframe + JS inject 路径）
 */

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
