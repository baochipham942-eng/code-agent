/**
 * 设计质量检测器的零依赖颜色小工具。
 *
 * 检测器不渲染任何东西，因此这些函数从源码文本里解析颜色*字面量*。
 * 支持现代前端代码里真实出现的格式：#hex、rgb()/rgba()、hsl()/hsla()
 * 与 oklch()。oklch 的 hue 是直接参数，故不做完整色彩空间转换（对
 * "是不是蓝色"这类色带判断而言过度）。
 *
 * 算法移植自 impeccable（Apache-2.0）。
 */

export type Rgb = { r: number; g: number; b: number; a: number };

/** 跨颜色格式做色带/对比判断时的归一化视图。 */
export type ColorInfo = {
  /** 色相，度数 [0,360)，无彩色/灰色为 null。 */
  hue: number | null;
  /** 感知亮度，0（黑）– 1（白）。 */
  lightness: number;
  /** 伪饱和度，0（灰）– 1（鲜艳）。 */
  saturation: number;
  /** 可推导出的 RGB 形式（oklch 不转换时为 null）。 */
  rgb: Rgb | null;
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 解析 #rgb / #rrggbb / #rrggbbaa hex 字面量。 */
export function parseHex(input: string): Rgb | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1];
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
    return { r, g, b, a };
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

/** 解析 rgb()/rgba()，逗号或空格分隔，可选 alpha。 */
export function parseRgb(input: string): Rgb | null {
  const m = /rgba?\(([^)]+)\)/i.exec(input);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (raw: string): number => {
    if (raw.endsWith('%')) return clamp01(parseFloat(raw) / 100) * 255;
    return Math.max(0, Math.min(255, parseFloat(raw)));
  };
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  const a =
    parts[3] != null
      ? parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3])
      : 1;
  return { r, g, b, a: Number.isNaN(a) ? 1 : clamp01(a) };
}

function hslToInfo(h: number, s: number, l: number, a: number): ColorInfo {
  return {
    hue: s < 0.04 ? null : ((h % 360) + 360) % 360,
    lightness: clamp01(l),
    saturation: clamp01(s),
    rgb: hslToRgb(h, s, l, a),
  };
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  // if/else 链穷尽 hp∈[0,6) 与末尾兜底，故 r/g/b 必被赋值，无需初值。
  let r: number;
  let g: number;
  let b: number;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a,
  };
}

/** 把 RGB 三元组转成 HSL 推导的 ColorInfo。 */
export function rgbToInfo(c: Rgb): ColorInfo {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0.00001) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { hue: s < 0.04 ? null : h, lightness: l, saturation: clamp01(s), rgb: c };
}

/**
 * 对单个颜色字面量的尽力归一化描述。当 token 不是可识别颜色时返回
 * null（如 `currentColor`、`var(--x)`、`transparent`）。
 */
export function describeColor(input: string): ColorInfo | null {
  const value = input.trim();
  if (
    !value ||
    /^(transparent|currentcolor|inherit|none|initial|unset|var\()/i.test(value)
  ) {
    return null;
  }
  // oklch(L C H [/ a])——hue 是直接参数；L 可为 % 或 0-1。
  const oklch = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i.exec(value);
  if (oklch) {
    const lRaw = oklch[1];
    const lightness = lRaw.endsWith('%')
      ? clamp01(parseFloat(lRaw) / 100)
      : clamp01(parseFloat(lRaw));
    const chroma = parseFloat(oklch[2]);
    const hue = ((parseFloat(oklch[3]) % 360) + 360) % 360;
    // 把 chroma（sRGB 色域内 ~0–0.4）映射到 0–1 伪饱和度。
    const saturation = clamp01(chroma / 0.37);
    return { hue: saturation < 0.04 ? null : hue, lightness, saturation, rgb: null };
  }
  const hsl = /hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/i.exec(
    value,
  );
  if (hsl) {
    return hslToInfo(parseFloat(hsl[1]), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100, 1);
  }
  const rgb = parseRgb(value);
  if (rgb) return rgbToInfo(rgb);
  const hex = parseHex(value);
  if (hex) return rgbToInfo(hex);
  return null;
}

/** 颜色是否实质为灰/中性（通道极差很小）。 */
export function isNeutral(c: Rgb): boolean {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 24;
}

/** sRGB 颜色的 WCAG 相对亮度。 */
export function relativeLuminance(c: Rgb): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** 两个 sRGB 颜色的 WCAG 对比度（1–21）。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 色相是否落在 紫→蓝 色带（AI 渐变签名）。 */
export function isPurpleOrBlueHue(hue: number | null): boolean {
  if (hue == null) return false;
  return hue >= 220 && hue <= 310;
}

/**
 * 从一个 CSS 值（如渐变）里抽出单个颜色字面量。匹配 #hex、
 * rgb()/rgba()、hsl()/hsla()、oklch()。
 */
export function extractColorLiterals(value: string): string[] {
  const out: string[] = [];
  const re = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[0]);
  return out;
}
