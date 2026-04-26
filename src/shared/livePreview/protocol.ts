// Live Preview ↔ Code Agent postMessage 协议
// 与 vite-plugin-code-agent-bridge v0.3.0 对齐
// 若升级协议，同步 /Users/linchen/Downloads/ai/vite-plugin-code-agent-bridge/src/protocol.ts
// 0.2.0: 新增 vg:restore-selection / vg:selection-stale 支持 HMR 回流恢复
// 0.3.0: SelectedElementInfo 加 className + computedStyle，支持 V2-B Tweak 面板

export const PROTOCOL_VERSION = '0.3.0';
export const MESSAGE_SOURCE_BRIDGE = 'visual-grounding-bridge';
export const MESSAGE_SOURCE_PARENT = 'vg:parent';

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** 0.3.0 — Tweak 面板需要的 computed style 子集 */
export interface ComputedStyleSnapshot {
  color?: string;
  backgroundColor?: string;
  padding?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  margin?: string;
  fontSize?: string;
  borderRadius?: string;
  textAlign?: string;
}

export interface SelectedElementInfo {
  location: SourceLocation;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string;
  /** 0.3.0 — DOM `class` 属性当前值，TweakPanel 解析展示 */
  className?: string;
  /** 0.3.0 — getComputedStyle 子集，TweakPanel 渲染当前值 */
  computedStyle?: ComputedStyleSnapshot;
}

export type BridgeMessage =
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:ready'; url: string }
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:select'; payload: SelectedElementInfo }
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:hover'; payload: SelectedElementInfo | null }
  // 0.2.0: parent 发起的 restore 匹配失败（元素被删、行号漂移到不可识别）
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:selection-stale'; location: SourceLocation };

export type ParentCommand =
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:simulate-click'; selector: string }
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:clear-selection' }
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:ping' }
  // 0.2.0: HMR 回流恢复。parent 在 vg:ready 后请求 bridge 按 source location
  // 反查 DOM 并重新高亮。匹配成功 bridge 发 vg:select，失败发 vg:selection-stale。
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:restore-selection'; location: SourceLocation };

export function isBridgeMessage(v: unknown): v is BridgeMessage {
  return typeof v === 'object' && v !== null && (v as { source?: unknown }).source === MESSAGE_SOURCE_BRIDGE;
}
