export interface DragViewportRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function isDragPointInsideVisibleRect(
  point: { clientX: number; clientY: number },
  rect: DragViewportRect,
  viewport: { width: number; height: number },
): boolean {
  const { clientX, clientY } = point;
  if (clientX <= 0 || clientY <= 0 || clientX >= viewport.width || clientY >= viewport.height) {
    return false;
  }
  return clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom;
}
