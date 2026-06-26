// ============================================================================
// Rules Loader - Path-specific rules from rules/*.md files
// ============================================================================
// Loads rule files with optional YAML frontmatter specifying path patterns.
// Supports @import directives for composing rules from multiple files.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import picomatch from 'picomatch';

export interface PathRule {
  paths: string[];
  content: string;
  source: string; // file path for debugging
}

/**
 * Parse frontmatter from a rules .md file.
 * Returns path patterns and the body content.
 */
function parseFrontmatter(content: string): { paths: string[]; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { paths: ['**'], body: content };

  const paths: string[] = [];
  const lines = match[1].split('\n');
  let inPaths = false;
  for (const line of lines) {
    if (line.startsWith('paths:')) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const itemMatch = line.match(/^\s+-\s+"(.+)"/);
      if (itemMatch) {
        paths.push(itemMatch[1]);
      } else if (!line.startsWith(' ') && line.trim() !== '') {
        inPaths = false;
      }
    }
  }

  return { paths: paths.length > 0 ? paths : ['**'], body: match[2] };
}

/**
 * Resolve @import directives in rule content.
 * Max 3 levels deep to prevent infinite recursion.
 */
async function resolveImports(content: string, basePath: string, depth = 0): Promise<string> {
  if (depth >= 3) return content;

  const lines = content.split('\n');
  const resolved: string[] = [];

  for (const line of lines) {
    const importMatch = line.match(/^@import\s+(.+)$/);
    if (importMatch) {
      const importPath = path.resolve(basePath, importMatch[1].trim());
      try {
        let imported = await fs.readFile(importPath, 'utf-8');
        imported = await resolveImports(imported, path.dirname(importPath), depth + 1);
        resolved.push(imported);
      } catch {
        resolved.push(`[Import failed: ${importMatch[1].trim()}]`);
      }
    } else {
      resolved.push(line);
    }
  }

  return resolved.join('\n');
}

/**
 * Load all rules from a directory.
 */
export async function loadRulesDir(dir: string): Promise<PathRule[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const rules: PathRule[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);
      const content = await fs.readFile(filePath, 'utf-8');
      const { paths, body } = parseFrontmatter(content);
      const resolvedBody = await resolveImports(body, dir);
      rules.push({ paths, content: resolvedBody.trim(), source: filePath });
    }

    return rules;
  } catch {
    return [];
  }
}

/**
 * Get rules whose path patterns match a specific file path.
 */
export function getMatchingRules(rules: PathRule[], filePath: string): string[] {
  return rules
    .filter((rule) => rule.paths.some((pattern) => picomatch.isMatch(filePath, pattern)))
    .map((rule) => rule.content);
}
