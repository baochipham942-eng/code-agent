// ============================================================================
// Tool Specifier Parser — Parses Tool(glob) syntax for permission rules
// ============================================================================

import picomatch from 'picomatch';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ParsedSpecifier {
  toolName: string;
  specifier?: string;
  specifierType: 'command' | 'path' | 'none';
}

// Tool name → specifier type mapping
const TOOL_SPECIFIER_TYPES: Record<string, 'command' | 'path'> = {
  Bash: 'command',
  Edit: 'path',
  Write: 'path',
  Read: 'path',
  Glob: 'path',
  Grep: 'path',
  ListDirectory: 'path',
};

// ----------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------

/**
 * Parse a rule string like "Bash(npm run *)" or "Edit(src/**)" into components.
 * Plain tool names like "Bash" are also supported (no specifier).
 */
export function parseToolSpecifier(rule: string): ParsedSpecifier {
  const match = rule.match(/^(\w+)\((.+)\)$/);
  if (match) {
    const toolName = match[1];
    const specifier = match[2];
    const specifierType = TOOL_SPECIFIER_TYPES[toolName] || 'none';
    return { toolName, specifier, specifierType };
  }

  // No parentheses — plain tool name
  return {
    toolName: rule,
    specifierType: TOOL_SPECIFIER_TYPES[rule] || 'none',
  };
}

// ----------------------------------------------------------------------------
// Matching
// ----------------------------------------------------------------------------

/**
 * Check if an input string matches a parsed specifier's glob pattern.
 *
 * For 'command' type: the input is the full bash command string.
 * For 'path' type: the input is the file path.
 * For 'none' type: always returns true (tool-level match only).
 */
export function matchSpecifier(specifier: ParsedSpecifier, input: string): boolean {
  if (!specifier.specifier) {
    return true; // No specifier means match all inputs for this tool
  }

  return picomatch.isMatch(input, specifier.specifier, {
    // For commands, use bash-like matching; for paths, handle ** properly
    bash: true,
    dot: true,
  });
}
