// ============================================================================
// PPT 颜色工具
// ============================================================================

/**
 * Convert a hex color string (without #) to HSL.
 * Supports both 3-digit ("f80") and 6-digit ("ff8800") hex.
 */
export function hexToHSL(hex: string): { h: number; s: number; l: number } {
  let expanded = hex;
  if (expanded.length === 3) {
    expanded = expanded[0] + expanded[0] + expanded[1] + expanded[1] + expanded[2] + expanded[2];
  }

  const r = parseInt(expanded.substring(0, 2), 16) / 255;
  const g = parseInt(expanded.substring(2, 4), 16) / 255;
  const b = parseInt(expanded.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    h = ((b - r) / d + 2) / 6;
  } else {
    h = ((r - g) / d + 4) / 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * Convert HSL values back to a 6-digit hex string (without #).
 */
export function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }

  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return toHex(r) + toHex(g) + toHex(b);
}

/**
 * Generate a palette of colors using golden angle (137.508 deg) hue shifts.
 * Keeps the same saturation and lightness as the base color.
 */
export function generateGoldenAnglePalette(baseHex: string, count: number): string[] {
  const { h, s, l } = hexToHSL(baseHex);
  const palette: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = (h + i * 137.508) % 360;
    palette.push(hslToHex(hue, s, l));
  }
  return palette;
}

/**
 * Adjust the lightness of a hex color by the given amount (-100 to 100).
 * The resulting lightness is clamped to the 0-100 range.
 */
export function adjustBrightness(hex: string, amount: number): string {
  const { h, s, l } = hexToHSL(hex);
  const newL = Math.max(0, Math.min(100, l + amount));
  return hslToHex(h, s, newL);
}
