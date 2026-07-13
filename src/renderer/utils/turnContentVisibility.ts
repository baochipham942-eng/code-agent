import type React from 'react';

export const HEAVY_TURN_CONTENT_MIN_CHARS = 800;
export const TURN_CONTENT_INTRINSIC_SIZE_PX = 320;

export const deferredTurnContentStyle: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: `auto ${TURN_CONTENT_INTRINSIC_SIZE_PX}px`,
};

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
