import type React from 'react';

export const HEAVY_TURN_CONTENT_MIN_CHARS = 800;
export const TURN_CONTENT_INTRINSIC_SIZE_PX = 320;

const CONTENT_INTRINSIC_SIZE_PX = {
  assistantText: TURN_CONTENT_INTRINSIC_SIZE_PX,
  assistantTextMedium: 640,
  assistantTextLong: 960,
  assistantCode: 620,
  toolCard: 160,
  codeCompact: 220,
  codeStandard: 420,
  codeCollapsed: 620,
  turnText: 1040,
  turnTool: 1060,
  turnCode: 680,
} as const;

export type DeferredContentKind = keyof typeof CONTENT_INTRINSIC_SIZE_PX;

export function getDeferredContentStyle(kind: DeferredContentKind): React.CSSProperties {
  return {
    contentVisibility: 'auto',
    containIntrinsicSize: `auto ${CONTENT_INTRINSIC_SIZE_PX[kind]}px`,
  };
}

export function getAssistantTextDeferredContentKind(content: string): DeferredContentKind {
  if (content.includes('```')) return 'assistantCode';
  const contentLength = content.length;
  if (contentLength >= 3000) return 'assistantTextLong';
  if (contentLength >= 1600) return 'assistantTextMedium';
  return 'assistantText';
}

export function getCodeBlockDeferredContentKind(lineCount: number): DeferredContentKind {
  if (lineCount <= 8) return 'codeCompact';
  if (lineCount <= 25) return 'codeStandard';
  return 'codeCollapsed';
}

export function shouldDeferTurnContentLayout({
  content,
  isStreaming,
  isUser,
}: {
  content: string;
  isStreaming: boolean;
  isUser: boolean;
}): boolean {
  return !isUser && !isStreaming && content.length >= HEAVY_TURN_CONTENT_MIN_CHARS;
}
