// ============================================================================
// PPT 样式提取器 - 从 PPTX 提取主题配置
// ============================================================================

import * as fs from 'fs';
import { DEFAULT_FALLBACK_COLORS, DEFAULT_FALLBACK_FONTS, DEFAULT_CODE_FONT } from './constants';
import type { ThemeConfig } from './types';

/**
 * Extract theme configuration from an existing PPTX file
 *
 * Reads the PPTX (ZIP archive), parses ppt/theme/theme1.xml,
 * extracts color scheme (a:clrScheme) and font scheme (a:fontScheme),
 * and converts to ThemeConfig format.
 *
 * @param pptxPath - Path to the .pptx file
 * @returns Extracted ThemeConfig or null if extraction fails
 */
export async function extractStyleFromPptx(pptxPath: string): Promise<ThemeConfig | null> {
  if (!fs.existsSync(pptxPath)) {
    return null;
  }

  try {
    const JSZip = require('jszip');
    const data = fs.readFileSync(pptxPath);
    const zip = await JSZip.loadAsync(data);

    // Find theme file
    const themeFile = Object.keys(zip.files).find(f =>
      f.startsWith('ppt/theme/theme') && f.endsWith('.xml')
    );

    if (!themeFile) {
      return null;
    }

    const themeXml = await zip.files[themeFile].async('string');
    return parseThemeXml(themeXml);
  } catch {
    return null;
  }
}

/**
 * Parse theme XML and extract colors and fonts
 */
function parseThemeXml(xml: string): ThemeConfig {
  const colors = extractColorScheme(xml);
  const fonts = extractFontScheme(xml);

  // Determine if dark based on background luminance
  const bgColor = colors.dk1 || '000000';
  const isDark = isColorDark(bgColor);

  return {
    name: 'Extracted Theme',
    bgColor: isDark ? bgColor : (colors.lt1 || 'ffffff'),
    bgSecondary: isDark ? lighten(bgColor, 10) : darken(colors.lt1 || 'ffffff', 5),
    textPrimary: isDark ? (colors.lt1 || 'ffffff') : (colors.dk1 || '000000'),
    textSecondary: isDark ? lighten(bgColor, 40) : darken(colors.lt1 || 'ffffff', 40),
    accent: colors.accent1 || DEFAULT_FALLBACK_COLORS.accent,
    accentGlow: colors.accent2 || lighten(colors.accent1 || DEFAULT_FALLBACK_COLORS.accent, 20),
    cardBorder: isDark ? lighten(bgColor, 15) : darken(colors.lt1 || 'ffffff', 15),
    isDark,
    fontTitle: fonts.majorFont || DEFAULT_FALLBACK_FONTS.title,
    fontBody: fonts.minorFont || DEFAULT_FALLBACK_FONTS.body,
    fontCode: DEFAULT_CODE_FONT,
    fontTitleCN: fonts.majorFontEA || undefined,
    fontBodyCN: fonts.minorFontEA || undefined,
  };
}

interface ColorScheme {
  dk1?: string;
  lt1?: string;
  dk2?: string;
  lt2?: string;
  accent1?: string;
  accent2?: string;
  accent3?: string;
  accent4?: string;
  accent5?: string;
  accent6?: string;
}

function extractColorScheme(xml: string): ColorScheme {
  const colors: ColorScheme = {};
  const colorNames = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

  for (const name of colorNames) {
    // Match <a:dk1><a:srgbClr val="RRGGBB"/></a:dk1> pattern
    const srgbMatch = xml.match(new RegExp(`<a:${name}>\\s*<a:srgbClr val="([0-9A-Fa-f]{6})"`));
    if (srgbMatch) {
      colors[name as keyof ColorScheme] = srgbMatch[1].toLowerCase();
      continue;
    }
    // Match system color reference
    const sysMatch = xml.match(new RegExp(`<a:${name}>\\s*<a:sysClr val="(\\w+)" lastClr="([0-9A-Fa-f]{6})"`));
    if (sysMatch) {
      colors[name as keyof ColorScheme] = sysMatch[2].toLowerCase();
    }
  }

  return colors;
}

interface FontScheme {
  majorFont?: string;
  minorFont?: string;
  majorFontEA?: string;
  minorFontEA?: string;
}

function extractFontScheme(xml: string): FontScheme {
  const fonts: FontScheme = {};

  // Major font (titles): <a:majorFont><a:latin typeface="FontName"/>
  const majorMatch = xml.match(/<a:majorFont>[\s\S]*?<a:latin typeface="([^"]+)"/);
  if (majorMatch) fonts.majorFont = majorMatch[1];

  // Minor font (body): <a:minorFont><a:latin typeface="FontName"/>
  const minorMatch = xml.match(/<a:minorFont>[\s\S]*?<a:latin typeface="([^"]+)"/);
  if (minorMatch) fonts.minorFont = minorMatch[1];

  // East Asian fonts
  const majorEAMatch = xml.match(/<a:majorFont>[\s\S]*?<a:ea typeface="([^"]+)"/);
  if (majorEAMatch) fonts.majorFontEA = majorEAMatch[1];

  const minorEAMatch = xml.match(/<a:minorFont>[\s\S]*?<a:ea typeface="([^"]+)"/);
  if (minorEAMatch) fonts.minorFontEA = minorEAMatch[1];

  return fonts;
}

function isColorDark(hex: string): boolean {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Perceived luminance
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

function lighten(hex: string, percent: number): string {
  return adjustColor(hex, percent);
}

function darken(hex: string, percent: number): string {
  return adjustColor(hex, -percent);
}

function adjustColor(hex: string, percent: number): string {
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);

  const amount = Math.round(2.55 * percent);
  r = Math.min(255, Math.max(0, r + amount));
  g = Math.min(255, Math.max(0, g + amount));
  b = Math.min(255, Math.max(0, b + amount));

  return [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}
