// ============================================================================
// Quote Normalizer - Handle smart quotes and typographic characters
// ============================================================================
// Normalizes curly/smart quotes to straight quotes, handles em-dash/en-dash,
// and enables fuzzy string matching for edit operations. This is essential
// because AI models often output typographic characters that don't match
// the actual file content.
// ============================================================================

/**
 * Mapping of smart/typographic characters to their ASCII equivalents
 */
export const SMART_CHAR_MAP: Record<string, string> = {
  // Quotes
  '\u2018': "'", // LEFT SINGLE QUOTATION MARK '
  '\u2019': "'", // RIGHT SINGLE QUOTATION MARK '
  '\u201A': "'", // SINGLE LOW-9 QUOTATION MARK ‚
  '\u201B': "'", // SINGLE HIGH-REVERSED-9 QUOTATION MARK ‛
  '\u201C': '"', // LEFT DOUBLE QUOTATION MARK "
  '\u201D': '"', // RIGHT DOUBLE QUOTATION MARK "
  '\u201E': '"', // DOUBLE LOW-9 QUOTATION MARK „
  '\u201F': '"', // DOUBLE HIGH-REVERSED-9 QUOTATION MARK ‟
  '\u2039': "'", // SINGLE LEFT-POINTING ANGLE QUOTATION MARK ‹
  '\u203A': "'", // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK ›
  '\u00AB': '"', // LEFT-POINTING DOUBLE ANGLE QUOTATION MARK «
  '\u00BB': '"', // RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK »

  // Dashes
  '\u2013': '-', // EN DASH –
  '\u2014': '--', // EM DASH —
  '\u2015': '--', // HORIZONTAL BAR ―
  '\u2212': '-', // MINUS SIGN −

  // Spaces
  '\u00A0': ' ', // NO-BREAK SPACE
  '\u2000': ' ', // EN QUAD
  '\u2001': ' ', // EM QUAD
  '\u2002': ' ', // EN SPACE
  '\u2003': ' ', // EM SPACE
  '\u2004': ' ', // THREE-PER-EM SPACE
  '\u2005': ' ', // FOUR-PER-EM SPACE
  '\u2006': ' ', // SIX-PER-EM SPACE
  '\u2007': ' ', // FIGURE SPACE
  '\u2008': ' ', // PUNCTUATION SPACE
  '\u2009': ' ', // THIN SPACE
  '\u200A': ' ', // HAIR SPACE
  '\u200B': '', // ZERO WIDTH SPACE
  '\u202F': ' ', // NARROW NO-BREAK SPACE
  '\u205F': ' ', // MEDIUM MATHEMATICAL SPACE
  '\u3000': ' ', // IDEOGRAPHIC SPACE

  // Ellipsis
  '\u2026': '...', // HORIZONTAL ELLIPSIS …

  // Apostrophes
  '\u02BC': "'", // MODIFIER LETTER APOSTROPHE ʼ
  '\u02BB': "'", // MODIFIER LETTER TURNED COMMA ʻ
  '\u0060': "'", // GRAVE ACCENT `
  '\u00B4': "'", // ACUTE ACCENT ´
};

/**
 * Build a regex pattern that matches all smart characters
 */
const SMART_CHAR_REGEX = new RegExp(
  Object.keys(SMART_CHAR_MAP)
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g'
);

/**
 * Normalize smart/typographic characters to their ASCII equivalents
 *
 * @param str - String that may contain smart quotes, em-dashes, etc.
 * @returns Normalized string with ASCII equivalents
 *
 * @example
 * normalizeQuotes('"Hello"') // Returns: '"Hello"'
 * normalizeQuotes('it's') // Returns: "it's"
 * normalizeQuotes('foo—bar') // Returns: "foo--bar"
 */
export function normalizeQuotes(str: string): string {
  return str.replace(SMART_CHAR_REGEX, (match) => SMART_CHAR_MAP[match] || match);
}

/**
 * Check if a string contains any smart/typographic characters
 *
 * @param str - String to check
 * @returns true if string contains smart characters
 */
export function containsSmartChars(str: string): boolean {
  return SMART_CHAR_REGEX.test(str);
}

/**
 * Find a matching substring with fuzzy quote matching
 *
 * When the search string contains smart quotes but the content has straight
 * quotes (or vice versa), this function will find the match.
 *
 * @param content - The file content to search in
 * @param search - The string to search for (may contain smart quotes)
 * @returns Object with match info, or null if not found
 *
 * @example
 * const content = 'const x = "hello";';
 * const search = 'const x = "hello";'; // smart quotes
 * const result = findMatchingString(content, search);
 * // Returns: { index: 0, original: 'const x = "hello";', normalized: 'const x = "hello";' }
 */
export function findMatchingString(
  content: string,
  search: string
): {
  index: number;
  original: string;
  normalized: string;
  wasNormalized: boolean;
} | null {
  // First try exact match
  const exactIndex = content.indexOf(search);
  if (exactIndex !== -1) {
    return {
      index: exactIndex,
      original: search,
      normalized: search,
      wasNormalized: false,
    };
  }

  // If search contains smart chars, try normalized match
  if (containsSmartChars(search)) {
    const normalizedSearch = normalizeQuotes(search);
    const normalizedIndex = content.indexOf(normalizedSearch);

    if (normalizedIndex !== -1) {
      return {
        index: normalizedIndex,
        original: content.substring(
          normalizedIndex,
          normalizedIndex + normalizedSearch.length
        ),
        normalized: normalizedSearch,
        wasNormalized: true,
      };
    }
  }

  // If content might have smart chars that search doesn't have
  // Normalize both and try to find
  const normalizedContent = normalizeQuotes(content);
  const normalizedSearch = normalizeQuotes(search);
  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);

  if (normalizedIndex !== -1) {
    // Need to map back to original content position
    // This is tricky because normalization can change string length
    // We'll scan through to find the corresponding position
    let originalPos = 0;
    let normalizedPos = 0;

    while (normalizedPos < normalizedIndex && originalPos < content.length) {
      const char = content[originalPos];
      const replacement = SMART_CHAR_MAP[char];
      if (replacement !== undefined) {
        normalizedPos += replacement.length;
      } else {
        normalizedPos += 1;
      }
      originalPos += 1;
    }

    // Find the end position
    let endOriginalPos = originalPos;
    let searchNormalizedPos = 0;

    while (
      searchNormalizedPos < normalizedSearch.length &&
      endOriginalPos < content.length
    ) {
      const char = content[endOriginalPos];
      const replacement = SMART_CHAR_MAP[char];
      if (replacement !== undefined) {
        searchNormalizedPos += replacement.length;
      } else {
        searchNormalizedPos += 1;
      }
      endOriginalPos += 1;
    }

    const originalMatch = content.substring(originalPos, endOriginalPos);

    return {
      index: originalPos,
      original: originalMatch,
      normalized: normalizedSearch,
      wasNormalized: true,
    };
  }

  return null;
}

/**
 * Count occurrences of a string with fuzzy quote matching
 *
 * @param content - The content to search in
 * @param search - The string to count
 * @returns Number of occurrences (with normalization considered)
 */
export function countMatchesWithNormalization(
  content: string,
  search: string
): number {
  // Normalize both for consistent counting
  const normalizedContent = normalizeQuotes(content);
  const normalizedSearch = normalizeQuotes(search);

  let count = 0;
  let pos = 0;

  while (true) {
    const index = normalizedContent.indexOf(normalizedSearch, pos);
    if (index === -1) break;
    count++;
    pos = index + 1;
  }

  return count;
}

/**
 * Replace string with fuzzy quote matching
 *
 * @param content - The content to modify
 * @param oldStr - The string to replace (may contain smart quotes)
 * @param newStr - The replacement string
 * @param replaceAll - Whether to replace all occurrences
 * @returns Object with result and metadata
 */
export function replaceWithNormalization(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean = false
): {
  result: string;
  replacedCount: number;
  wasNormalized: boolean;
} {
  // First try exact replacement
  if (content.includes(oldStr)) {
    if (replaceAll) {
      const parts = content.split(oldStr);
      return {
        result: parts.join(newStr),
        replacedCount: parts.length - 1,
        wasNormalized: false,
      };
    } else {
      return {
        result: content.replace(oldStr, newStr),
        replacedCount: 1,
        wasNormalized: false,
      };
    }
  }

  // Try with normalization
  const match = findMatchingString(content, oldStr);
  if (!match) {
    return { result: content, replacedCount: 0, wasNormalized: false };
  }

  if (replaceAll) {
    // For replace all with normalization, we need to repeatedly find and replace
    let result = content;
    let count = 0;
    let currentMatch = findMatchingString(result, oldStr);

    while (currentMatch) {
      result =
        result.substring(0, currentMatch.index) +
        newStr +
        result.substring(currentMatch.index + currentMatch.original.length);
      count++;
      currentMatch = findMatchingString(result, oldStr);

      // Safety: prevent infinite loops
      if (count > 10000) break;
    }

    return { result, replacedCount: count, wasNormalized: true };
  } else {
    const result =
      content.substring(0, match.index) +
      newStr +
      content.substring(match.index + match.original.length);

    return { result, replacedCount: 1, wasNormalized: true };
  }
}

/**
 * Get a list of smart characters found in a string (for debugging/reporting)
 *
 * @param str - String to analyze
 * @returns Array of found smart characters with their positions
 */
export function findSmartChars(
  str: string
): Array<{ char: string; position: number; replacement: string }> {
  const results: Array<{ char: string; position: number; replacement: string }> =
    [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const replacement = SMART_CHAR_MAP[char];
    if (replacement !== undefined) {
      results.push({ char, position: i, replacement });
    }
  }

  return results;
}
