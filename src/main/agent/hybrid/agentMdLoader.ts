// ============================================================================
// Agent Markdown Loader - Parse .md files with YAML frontmatter
// ============================================================================
// Loads custom agent definitions from .code-agent/agents/*.md files.
// Frontmatter defines agent config; body becomes the agent prompt.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CoreAgentConfig, CoreAgentId, ModelTier } from './coreAgents';

interface AgentMdFrontmatter {
  name: string;
  description?: string;
  model?: ModelTier;
  tools?: string[];
  'max-iterations'?: number;
}

/**
 * Parse a single agent .md file.
 * Returns null if the file has no valid frontmatter.
 */
export function parseAgentMd(content: string, filename: string): CoreAgentConfig | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const frontmatter = parseSimpleYaml(frontmatterMatch[1]);
  const prompt = frontmatterMatch[2].trim();

  const name = frontmatter.name || path.basename(filename, '.md');

  return {
    id: name as CoreAgentId,
    name: frontmatter.description || name,
    description: frontmatter.description || `Custom agent: ${name}`,
    prompt,
    tools: frontmatter.tools || ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    model: (frontmatter.model as ModelTier) || 'balanced',
    maxIterations: frontmatter['max-iterations'] || 30,
    readonly: false,
  };
}

/**
 * Simple YAML parser for frontmatter.
 * Handles key: value pairs and key: [array] / key:\n  - item syntax.
 */
function parseSimpleYaml(yaml: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Array item: "  - value"
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch && currentKey) {
      if (!currentArray) {
        currentArray = [];
        result[currentKey] = currentArray;
      }
      // Strip surrounding quotes
      const val = arrayItemMatch[1].replace(/^["']|["']$/g, '');
      currentArray.push(val);
      continue;
    }

    // Key: value pair
    const kvMatch = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();
      currentArray = null;

      if (value === '' || value === '[]') {
        // Value will come from subsequent array items, or is empty array
        if (value === '[]') {
          result[currentKey] = [];
          currentKey = null;
        }
        continue;
      }

      // Inline array: [a, b, c]
      const inlineArrayMatch = value.match(/^\[(.+)\]$/);
      if (inlineArrayMatch) {
        result[currentKey] = inlineArrayMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''));
        currentKey = null;
        continue;
      }

      // Number
      if (/^\d+$/.test(value)) {
        result[currentKey] = parseInt(value, 10);
        currentKey = null;
        continue;
      }

      // Boolean
      if (value === 'true' || value === 'false') {
        result[currentKey] = value === 'true';
        currentKey = null;
        continue;
      }

      // String (strip quotes)
      result[currentKey] = value.replace(/^["']|["']$/g, '');
      currentKey = null;
    }
  }

  return result;
}

/**
 * Load all agent .md files from a directory.
 */
export async function loadAgentMdFiles(dir: string): Promise<CoreAgentConfig[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const agents: CoreAgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    const content = await fs.readFile(filePath, 'utf-8');
    const agent = parseAgentMd(content, entry.name);
    if (agent) {
      agents.push(agent);
    }
  }

  return agents;
}
