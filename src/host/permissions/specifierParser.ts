// ============================================================================
// Tool Specifier Parser — Parses Tool(glob) syntax for permission rules
// ============================================================================

import picomatch from 'picomatch';
import { lenientCompoundSegments, splitCompoundCommand } from '../security/commandSafety';

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

/** allow = the rule grants something; restrict = deny / ask. They fail in opposite directions. */
export type SpecifierMatchIntent = 'allow' | 'restrict';

const GLOB_OPTIONS = { bash: true, dot: true } as const;

function globMatches(pattern: string, input: string): boolean {
  return picomatch.isMatch(input, pattern, GLOB_OPTIONS);
}

// splitCompoundCommand() rebuilds each segment through shell-quote, which escapes `~`, `=` …
// A rule is written against what the user typed, so try the segment with those escapes removed too.
function segmentSpellings(segment: string): string[] {
  const unescaped = segment.replace(/\\(.)/g, '$1');
  return unescaped === segment ? [segment] : [segment, unescaped];
}

/**
 * A glob `*` also matches `;`, `&&`, `|`, `$(…)`: matched against the whole string,
 * `Bash(npm run *)` pre-approved `npm run build; cat ~/.ssh/id_rsa`, and `Bash(rm *)` as a deny
 * missed `ls; rm -rf x`. Commands are therefore matched per simple command.
 *
 * allow    — every simple command must match; a command we cannot structure (substitution,
 *            subshell, background, parse failure) is never pre-approved.
 * restrict — the whole string or any simple command matching is enough.
 */
function matchCommandSpecifier(pattern: string, command: string, intent: SpecifierMatchIntent): boolean {
  if (intent === 'restrict') {
    if (globMatches(pattern, command)) return true;
    const lenient = lenientCompoundSegments(command)?.segments ?? [];
    return lenient.some((segment) => segmentSpellings(segment).some((text) => globMatches(pattern, text)));
  }
  const segments = splitCompoundCommand(command);
  if (!segments || segments.length === 0) return false;
  if (segments.length === 1) {
    return globMatches(pattern, command.trim())
      || segmentSpellings(segments[0]).some((text) => globMatches(pattern, text));
  }
  return segments.every((segment) => segmentSpellings(segment).some((text) => globMatches(pattern, text)));
}

/**
 * Check if an input string matches a parsed specifier's glob pattern.
 *
 * For 'command' type: the input is the full bash command string, matched per simple command
 *   (see matchCommandSpecifier). Without an intent it is treated as 'allow', the fail-closed side.
 * For 'path' type: the input is the file path.
 * For 'none' type: always returns true (tool-level match only).
 */
export function matchSpecifier(
  specifier: ParsedSpecifier,
  input: string,
  intent: SpecifierMatchIntent = 'allow',
): boolean {
  if (!specifier.specifier) {
    return true; // No specifier means match all inputs for this tool
  }
  if (specifier.specifierType === 'command') {
    return matchCommandSpecifier(specifier.specifier, input, intent);
  }
  return globMatches(specifier.specifier, input);
}
