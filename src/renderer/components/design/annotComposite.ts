// 合成导出：把显示空间标注坐标换算到原图分辨率，并烘焙成 PNG dataURL。
import type { AnnotShape } from './AnnotationLayer';
import { ANNOT_COLOR } from './AnnotationLayer';

export interface ComposeInput {
  naturalW: number; // 原图像素宽
  naturalH: number; // 原图像素高
  displayW: number; // 画布显示宽
  displayH: number; // 画布显示高
  shapes: AnnotShape[]; // 显示空间坐标的标注
}

/**
 * 纯函数：把显示空间的标注坐标按 原图/显示 比例换算到原图像素空间。
 * 不修改入参，返回新数组。
 */
export function composeAnnotOps(input: ComposeInput): AnnotShape[] {
  const { naturalW, naturalH, displayW, displayH, shapes } = input;
  const sx = naturalW / displayW;
  const sy = naturalH / displayH;

  return shapes.map((shape) => {
    switch (shape.kind) {
      case 'pen':
        // points 格式 [x0,y0,x1,y1,...] — 偶数索引 × sx，奇数索引 × sy
        return {
          ...shape,
          points: shape.points.map((v, i) => (i % 2 === 0 ? v * sx : v * sy)),
        };
      case 'arrow':
        // points: [x0, y0, x1, y1]
        return {
          ...shape,
          points: [
            shape.points[0] * sx,
            shape.points[1] * sy,
            shape.points[2] * sx,
            shape.points[3] * sy,
          ] as [number, number, number, number],
        };
      case 'rect':
        return {
          ...shape,
          x: shape.x * sx,
          y: shape.y * sy,
          w: shape.w * sx,
          h: shape.h * sy,
        };
      case 'text':
        // 文字内容与颜色不变，仅坐标换算
        return {
          ...shape,
          x: shape.x * sx,
          y: shape.y * sy,
        };
      default:
        return shape;
    }
  });
}

/**
 * 在原图分辨率的离屏 canvas 上绘制 [原图 + 缩放后的标注]，返回 PNG dataURL。
 * 仅运行时（renderer）调用，依赖 DOM；不进单测（dogfood 覆盖）。
 * @param sourceImageDataUrl 原图 dataURL
 * @param scaledShapes 已按原图分辨率换算的标注（来自 composeAnnotOps）
 * @param naturalW 原图像素宽
 * @param naturalH 原图像素高
 */
export async function exportAnnotatedPng(
  sourceImageDataUrl: string,
  scaledShapes: AnnotShape[],
  naturalW: number,
  naturalH: number,
): Promise<string> {
  // 加载原图
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = sourceImageDataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = naturalW;
  canvas.height = naturalH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('exportAnnotatedPng: canvas 2d context 不可用');

  // 绘制底图
  ctx.drawImage(img, 0, 0, naturalW, naturalH);

  // 绘制各标注图形
  ctx.strokeStyle = ANNOT_COLOR;
  ctx.fillStyle = ANNOT_COLOR;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const shape of scaledShapes) {
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;

    switch (shape.kind) {
      case 'pen': {
        if (shape.points.length < 4) break;
        ctx.beginPath();
        ctx.moveTo(shape.points[0], shape.points[1]);
        for (let i = 2; i < shape.points.length; i += 2) {
          ctx.lineTo(shape.points[i], shape.points[i + 1]);
        }
        ctx.stroke();
        break;
      }
      case 'arrow': {
        const [x0, y0, x1, y1] = shape.points;
        // 主线
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        // 箭头三角（简单实现）
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const headLen = 14;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(
          x1 - headLen * Math.cos(angle - Math.PI / 6),
          y1 - headLen * Math.sin(angle - Math.PI / 6),
        );
        ctx.lineTo(
          x1 - headLen * Math.cos(angle + Math.PI / 6),
          y1 - headLen * Math.sin(angle + Math.PI / 6),
        );
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'rect': {
        ctx.lineWidth = 2;
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
        ctx.lineWidth = 3;
        break;
      }
      case 'text': {
        ctx.font = '18px sans-serif';
        ctx.fillText(shape.text, shape.x, shape.y);
        break;
      }
    }
  }

  return canvas.toDataURL('image/png');
}
