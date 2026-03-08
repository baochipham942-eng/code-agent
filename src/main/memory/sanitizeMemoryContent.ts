// ============================================================================
// Memory Content Sanitization
// ============================================================================
// Prevents prompt injection via stored memory content by escaping dangerous
// characters and stripping system-level closing tags.
// ============================================================================

/** Maximum characters per individual memory entry after sanitization */
const SANITIZE_MAX_CHARS = 200;

/** Closing tags that must be stripped to prevent XML injection */
const DANGEROUS_CLOSING_TAGS = [
  '</system>',
  '</contextual-memory>',
  '</seed-memory>',
  '</current-plan>',
];

/**
 * Sanitize memory content before injecting into system prompts.
 * - Escapes < and > to prevent XML tag injection
 * - Strips dangerous closing tags
 * - Truncates to max length
 */
export function sanitizeMemoryContent(text: string): string {
  if (!text) return '';

  let sanitized = text;

  // Strip dangerous closing tags (case-insensitive) before escaping,
  // so we catch them even if they appear verbatim
  for (const tag of DANGEROUS_CLOSING_TAGS) {
    sanitized = sanitized.replace(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  // Escape < and > to prevent XML tag injection
  sanitized = sanitized.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Truncate to max length
  if (sanitized.length > SANITIZE_MAX_CHARS) {
    sanitized = sanitized.substring(0, SANITIZE_MAX_CHARS - 3) + '...';
  }

  return sanitized;
}
