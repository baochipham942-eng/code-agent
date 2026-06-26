// 品牌契约 → PPT ThemeConfig（增强 #3）：把「我的品牌」的色板/字体注入演示稿主题。
// 品牌色板存的是 oklch（也可能是 hex），ThemeConfig 要 6 位无 # hex（pptxgenjs 格式），
// 故需 OKLCH→sRGB 转换。color.ts 不转 oklch、tinycolor2 不支持，这里按标准矩阵实现。
import type { BrandContract } from '@shared/contract/brandContract';
import type { ThemeConfig } from '../../tools/media/ppt/types';
import { parseHex, parseRgb, type Rgb } from '../../quality/color';

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** OKLCH 字符串 → sRGB(0-255)。标准 OKLab 矩阵 + sRGB gamma。无法解析返回 null。 */
export function oklchToRgb(input: string): Rgb | null {
  const m = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i.exec(input.trim());
  if (!m) return null;
  const L = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  const C = parseFloat(m[2]);
  const hDeg = parseFloat(m[3]);
  if (Number.isNaN(L) || Number.isNaN(C) || Number.isNaN(hDeg)) return null;

  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  // OKLab → LMS（立方根空间逆变换）
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  // LMS → 线性 sRGB
  const lr = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const lg = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const lb = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;

  // 线性 → sRGB gamma
  const gamma = (c: number): number =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

  return {
    r: Math.round(clamp01(gamma(lr)) * 255),
    g: Math.round(clamp01(gamma(lg)) * 255),
    b: Math.round(clamp01(gamma(lb)) * 255),
    a: 1,
  };
}

/** 任意颜色字面量（hex / rgb / oklch）→ sRGB。无法解析返回 null。 */
export function colorToRgb(input: string): Rgb | null {
  return parseHex(input) ?? parseRgb(input) ?? oklchToRgb(input);
}

const toHex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** sRGB → 6 位无 # hex（pptxgenjs 格式）。 */
export function rgbToHex6(rgb: Rgb): string {
  return `${toHex2(rgb.r)}${toHex2(rgb.g)}${toHex2(rgb.b)}`;
}

/** 任意颜色 → 6 位无 # hex；无法解析回退 fallback。 */
export function colorToHex6(input: string, fallback: string): string {
  const rgb = colorToRgb(input);
  return rgb ? rgbToHex6(rgb) : fallback;
}

/** sRGB 相对亮度（粗略，用于明暗主题判定）。 */
function luminance(rgb: Rgb): number {
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/** 把颜色向白（amount>0）或黑（amount<0）线性混合，返回 6 位 hex。用于派生次级背景/边框。 */
function mixToward(rgb: Rgb, towardWhite: boolean, amount: number): string {
  const target = towardWhite ? 255 : 0;
  const mix = (c: number): number => c + (target - c) * amount;
  return rgbToHex6({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b), a: 1 });
}

/**
 * 品牌契约 → ThemeConfig。色板按字段映射 + 派生次级背景/边框，字体取品牌字体栈。
 * 任意颜色无法解析时回退到中性默认，保证生成不崩。
 */
export function themeConfigFromBrand(brand: BrandContract): ThemeConfig {
  const p = brand.tokens.palette;
  const surfaceRgb = colorToRgb(p.surface) ?? { r: 13, g: 13, b: 13, a: 1 };
  const isDark = luminance(surfaceRgb) < 0.5;

  return {
    name: brand.name || '品牌主题',
    bgColor: rgbToHex6(surfaceRgb),
    bgSecondary: mixToward(surfaceRgb, isDark, 0.06),
    textPrimary: colorToHex6(p.contrast, isDark ? 'f5f5f5' : '111111'),
    textSecondary: colorToHex6(p.muted, isDark ? 'a3a3a3' : '666666'),
    accent: colorToHex6(p.accent, '3b82f6'),
    accentGlow: colorToHex6(p.primary, '60a5fa'),
    cardBorder: mixToward(surfaceRgb, isDark, 0.15),
    isDark,
    fontTitle: brand.tokens.fonts.serif || 'Georgia, serif',
    fontBody: brand.tokens.fonts.sans || 'Arial, sans-serif',
    fontCode: 'Courier New',
    fontTitleCN: 'Microsoft YaHei',
    fontBodyCN: 'Microsoft YaHei',
  };
}
