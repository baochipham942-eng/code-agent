import type React from 'react';

export const HEAVY_TURN_CONTENT_MIN_CHARS = 800;
export const TURN_CONTENT_INTRINSIC_SIZE_PX = 320;

export const CONTENT_INTRINSIC_SIZE_PX = {
  assistantText: TURN_CONTENT_INTRINSIC_SIZE_PX,
  toolCard: 160,
  codeCompact: 220,
  codeStandard: 420,
  codeCollapsed: 620,
  turnText: 420,
  turnTool: 560,
  turnCode: 760,
} as const;

export type DeferredContentKind = keyof typeof CONTENT_INTRINSIC_SIZE_PX;

export function getDeferredContentStyle(kind: DeferredContentKind): React.CSSProperties {
  return {
    contentVisibility: 'auto',
    containIntrinsicSize: `auto ${CONTENT_INTRINSIC_SIZE_PX[kind]}px`,
  };
}

export const deferredTurnContentStyle = getDeferredContentStyle('assistantText');

export function getCodeBlockDeferredContentKind(lineCount: number): DeferredContentKind {
  if (lineCount <= 8) return 'codeCompact';
  if (lineCount <= 25) return 'codeStandard';
  return 'codeCollapsed';
}

export function getTurnDeferredContentKind({
  hasCodeBlock,
  hasToolCard,
}: {
  hasCodeBlock: boolean;
  hasToolCard: boolean;
}): DeferredContentKind {
  if (hasCodeBlock) return 'turnCode';
  if (hasToolCard) return 'turnTool';
  return 'turnText';
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
