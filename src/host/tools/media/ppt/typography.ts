// ============================================================================
// PPT 中英文排版工具
// ============================================================================

/**
 * CJK Unicode ranges:
 * - \u4e00-\u9fff  CJK Unified Ideographs
 * - \u3400-\u4dbf  CJK Unified Ideographs Extension A
 * - \u3000-\u303f  CJK Symbols and Punctuation
 * - \uff00-\uffef  Halfwidth and Fullwidth Forms
 * - \u3040-\u309f  Hiragana
 * - \u30a0-\u30ff  Katakana
 */
import { TEXT_METRICS } from './constants';

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff]/;
const CJK_REGEX_G = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff]/g;

/**
 * Returns the ratio (0-1) of CJK characters in the text.
 * Returns 0 for empty strings.
 */
export function detectCJKRatio(text: string): number {
  if (!text || text.length === 0) return 0;

  const matches = text.match(CJK_REGEX_G);
  const cjkCount = matches ? matches.length : 0;

  return cjkCount / text.length;
}

/**
 * Returns true if CJK characters make up more than 30% of the text.
 */
export function isCJKDominant(text: string): boolean {
  return detectCJKRatio(text) > TEXT_METRICS.CJK_DOMINANT_THRESHOLD;
}

/**
 * Select the appropriate font based on whether the text is CJK-dominant.
 *
 * If the text is CJK-dominant and a CN font variant is provided, use the CN font.
 * Otherwise use the regular (Latin) font.
 *
 * @param text - The text content to analyze
 * @param titleFont - Latin/default title font
 * @param bodyFont - Latin/default body font
 * @param titleFontCN - Optional CJK title font
 * @param bodyFontCN - Optional CJK body font
 * @param isTitle - Whether this is a title (true) or body text (false/undefined)
 */
export function selectFont(
  text: string,
  titleFont: string,
  bodyFont: string,
  titleFontCN?: string,
  bodyFontCN?: string,
  isTitle?: boolean,
): string {
  const cjkDominant = isCJKDominant(text);

  if (isTitle) {
    return cjkDominant && titleFontCN ? titleFontCN : titleFont;
  }
  return cjkDominant && bodyFontCN ? bodyFontCN : bodyFont;
}

/**
 * Add a space between CJK and Latin/digit characters where missing.
 *
 * Examples:
 *   "中文text"  → "中文 text"
 *   "abc中文"   → "abc 中文"
 *   "中文 text" → "中文 text" (unchanged, space already present)
 *   "测试123"   → "测试 123"
 */
export function normalizeCJKSpacing(text: string): string {
  if (!text) return text;

  // CJK followed by Latin/digit (no space between)
  let result = text.replace(
    /([\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff])([A-Za-z0-9])/g,
    '$1 $2',
  );

  // Latin/digit followed by CJK (no space between)
  result = result.replace(
    /([A-Za-z0-9])([\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff])/g,
    '$1 $2',
  );

  return result;
}

/**
 * Approximate character width in inches for font size estimation.
 * CJK characters are roughly square, so width ≈ fontSize * 0.035 inches.
 * Latin characters are narrower, approximately fontSize * 0.02 inches.
 */
const CJK_WIDTH_FACTOR = TEXT_METRICS.CJK_WIDTH_FACTOR;
const LATIN_WIDTH_FACTOR = TEXT_METRICS.LATIN_WIDTH_FACTOR;
const LINE_HEIGHT_FACTOR = TEXT_METRICS.LINE_HEIGHT_FACTOR;

/**
 * Estimate if text fits in a bounding box and calculate the appropriate font size.
 *
 * Reduces font size from baseFontSize until the text fits within the given
 * maxWidth and maxHeight (in inches), but never below minFontSize.
 *
 * @param text - The text content (may contain newlines)
 * @param maxWidth - Maximum available width in inches
 * @param maxHeight - Maximum available height in inches
 * @param baseFontSize - Starting font size in points
 * @param minFontSize - Minimum font size in points (default: 10)
 * @returns The calculated font size in points
 */
export function calculateFitFontSize(
  text: string,
  maxWidth: number,
  maxHeight: number,
  baseFontSize: number,
  minFontSize: number = 10,
): number {
  if (!text || maxWidth <= 0 || maxHeight <= 0) return baseFontSize;

  const lines = text.split('\n');
  let fontSize = baseFontSize;

  while (fontSize > minFontSize) {
    const lineHeightInches = (fontSize / 72) * LINE_HEIGHT_FACTOR;
    const totalHeight = lines.length * lineHeightInches;

    // Find the widest line
    let maxLineWidth = 0;
    for (const line of lines) {
      let lineWidth = 0;
      for (const char of line) {
        if (CJK_REGEX.test(char)) {
          lineWidth += fontSize * CJK_WIDTH_FACTOR;
        } else {
          lineWidth += fontSize * LATIN_WIDTH_FACTOR;
        }
      }
      if (lineWidth > maxLineWidth) {
        maxLineWidth = lineWidth;
      }
    }

    // Check if it fits
    if (maxLineWidth <= maxWidth && totalHeight <= maxHeight) {
      return fontSize;
    }

    // Scale down: pick the more constraining dimension ratio
    const widthRatio = maxLineWidth > 0 ? maxWidth / maxLineWidth : 1;
    const heightRatio = totalHeight > 0 ? maxHeight / totalHeight : 1;
    const scaleRatio = Math.min(widthRatio, heightRatio);

    const nextFontSize = Math.floor(fontSize * scaleRatio);

    // Ensure we always decrease by at least 1 to avoid infinite loop
    fontSize = nextFontSize < fontSize ? nextFontSize : fontSize - 1;
  }

  return minFontSize;
}
