// object-contain 画面坐标 → 真实视口坐标映射（浏览器三期 P1）。
// 画面居中 letterbox/pillarbox，点击空白黑边返回 null。

export interface DisplayRect {
  width: number;
  height: number;
}

export interface ContentSize {
  width: number;
  height: number;
}

export interface DisplayPoint {
  x: number;
  y: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface ContainedContentLayout {
  offsetX: number;
  offsetY: number;
  displayedWidth: number;
  displayedHeight: number;
  scaleX: number;
  scaleY: number;
}

/**
 * 计算 object-contain 内容区在容器中的实际布局（含 letterbox 偏移与缩放）。
 * 容器或内容尺寸非法时返回 null。
 */
export function resolveObjectContainLayout(
  display: DisplayRect,
  content: ContentSize,
): ContainedContentLayout | null {
  if (
    !Number.isFinite(display.width) || !Number.isFinite(display.height)
    || !Number.isFinite(content.width) || !Number.isFinite(content.height)
    || display.width <= 0 || display.height <= 0
    || content.width <= 0 || content.height <= 0
  ) {
    return null;
  }

  const contentAspect = content.width / content.height;
  const displayAspect = display.width / display.height;

  let displayedWidth: number;
  let displayedHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (contentAspect > displayAspect) {
    // 内容更宽：左右贴边，上下 letterbox
    displayedWidth = display.width;
    displayedHeight = display.width / contentAspect;
    offsetX = 0;
    offsetY = (display.height - displayedHeight) / 2;
  } else {
    // 内容更高或等比：上下贴边，左右 pillarbox
    displayedHeight = display.height;
    displayedWidth = display.height * contentAspect;
    offsetX = (display.width - displayedWidth) / 2;
    offsetY = 0;
  }

  if (displayedWidth <= 0 || displayedHeight <= 0) return null;

  return {
    offsetX,
    offsetY,
    displayedWidth,
    displayedHeight,
    scaleX: content.width / displayedWidth,
    scaleY: content.height / displayedHeight,
  };
}

/**
 * 将显示区域内点击点映射到页面视口 CSS 像素。
 * 点在 letterbox 黑边外时返回 null（不透传）。
 */
export function mapDisplayPointToViewport(
  point: DisplayPoint,
  display: DisplayRect,
  content: ContentSize,
): ViewportPoint | null {
  const layout = resolveObjectContainLayout(display, content);
  if (!layout) return null;

  const localX = point.x - layout.offsetX;
  const localY = point.y - layout.offsetY;
  if (
    localX < 0 || localY < 0
    || localX > layout.displayedWidth
    || localY > layout.displayedHeight
  ) {
    return null;
  }

  return {
    x: localX * layout.scaleX,
    y: localY * layout.scaleY,
  };
}
