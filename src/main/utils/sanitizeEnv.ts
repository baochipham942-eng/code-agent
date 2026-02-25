// ============================================================================
// Environment Variable Sanitization
//
// Strips control characters from environment variable values before passing
// to child processes or API calls. Prevents EINVAL errors on Windows and
// other platforms that are strict about env var content.
//
// Inspired by CodePilot's sanitizeEnv() pattern.
// ============================================================================

/**
 * Remove ASCII control characters (except whitespace) from a string.
 * These characters can cause EINVAL errors when passed to child_process.spawn()
 * on Windows and other strict environments.
 */
export function sanitizeEnvValue(value: string): string {
  // Remove C0 control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F) and DEL (0x7F)
  // Preserve: \t (0x09), \n (0x0A), \r (0x0D) as they are valid whitespace
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Sanitize all values in an environment variable record.
 * - Filters out non-string values (Windows spawn requires all string values)
 * - Removes control characters from string values
 * - Removes entries with empty keys
 */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    // Skip empty keys
    if (!key) continue;

    // Skip undefined/null values
    if (value == null) continue;

    // Ensure value is a string (Windows spawn is strict)
    const strValue = String(value);

    // Sanitize the value
    result[key] = sanitizeEnvValue(strValue);
  }

  return result;
}

/**
 * Create a sanitized copy of process.env suitable for child process spawning.
 * Optionally merge additional env vars.
 */
export function createSanitizedEnv(
  extra?: Record<string, string | undefined>
): Record<string, string> {
  const base = sanitizeEnv(process.env as Record<string, string | undefined>);

  if (extra) {
    const sanitizedExtra = sanitizeEnv(extra);
    Object.assign(base, sanitizedExtra);
  }

  return base;
}
