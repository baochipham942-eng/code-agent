// ============================================================================
// Coordinate Transform - 图像坐标 → 逻辑屏幕点
// ============================================================================
// 视觉模型看到的截图经过 Gap 1 降采样后处于"分析图像空间"（analyzedWidth × analyzedHeight 像素）。
// 而 osascript / cliclick / CGEvent 执行器吃的是"逻辑屏幕点"（pointWidth × pointHeight）。
// 这个纯函数是两个空间之间唯一的换算来源。
//
// 关键：必须 ratio-based（displayPointWidth / analyzedWidth），不能 shortcut 成"除以 2"——
// 这样无论 Gap 1 的 MAX_EDGE_PX 怎么调、resize 到不到点空间，换算都正确。

export interface CoordinateTransformContext {
  /** Gap 1 记账的分析图像像素尺寸 */
  analyzedWidth: number | null;
  analyzedHeight: number | null;
  /** Gap 2 实测的主显示器逻辑点尺寸 */
  displayPointWidth: number | null;
  displayPointHeight: number | null;
}

/**
 * 把分析图像空间的坐标换算成逻辑屏幕点。
 * 任一输入缺失 → 原样返回（= 现有行为，不做变换）。
 */
export function imageCoordsToScreenPoints(
  coord: { x: number; y: number },
  ctx: CoordinateTransformContext,
): { x: number; y: number } {
  const { analyzedWidth, analyzedHeight, displayPointWidth, displayPointHeight } = ctx;
  if (
    !analyzedWidth ||
    !analyzedHeight ||
    !displayPointWidth ||
    !displayPointHeight ||
    analyzedWidth <= 0 ||
    analyzedHeight <= 0
  ) {
    return coord;
  }
  const scaleX = displayPointWidth / analyzedWidth;
  const scaleY = displayPointHeight / analyzedHeight;
  return {
    x: coord.x * scaleX,
    y: coord.y * scaleY,
  };
}
