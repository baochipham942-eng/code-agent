// Live Preview ↔ Code Agent postMessage 协议
// 与 vite-plugin-code-agent-bridge v0.1.0 对齐
// 若升级协议，同步 /Users/linchen/Downloads/ai/vite-plugin-code-agent-bridge/src/protocol.ts

export const PROTOCOL_VERSION = '0.1.0';
export const MESSAGE_SOURCE_BRIDGE = 'visual-grounding-bridge';
export const MESSAGE_SOURCE_PARENT = 'vg:parent';

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface SelectedElementInfo {
  location: SourceLocation;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string;
}

export type BridgeMessage =
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:ready'; url: string }
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:select'; payload: SelectedElementInfo }
  | { source: typeof MESSAGE_SOURCE_BRIDGE; version: string; type: 'vg:hover'; payload: SelectedElementInfo | null };

export type ParentCommand =
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:simulate-click'; selector: string }
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:clear-selection' }
  | { source: typeof MESSAGE_SOURCE_PARENT; type: 'vg:ping' };

export function isBridgeMessage(v: unknown): v is BridgeMessage {
  return typeof v === 'object' && v !== null && (v as { source?: unknown }).source === MESSAGE_SOURCE_BRIDGE;
}
