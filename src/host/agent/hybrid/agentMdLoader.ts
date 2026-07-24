// ============================================================================
// Agent Markdown Loader - Parse .md files with YAML frontmatter
// ============================================================================
// Loads custom agent definitions from .code-agent/agents/*.md files.
// Frontmatter defines agent config; body becomes the agent prompt.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { RoleProactivityLevel, RoleVisual } from '../../../shared/contract/roleAssets';
import type { SkillCategory } from '../../../shared/contract/skillRepository';
import type { CoreAgentConfig, CoreAgentId, ModelTier } from './types';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function nonEmptyStringArrayValue(value: unknown): string[] | undefined {
  const items = stringArrayValue(value)?.map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function modelTierValue(value: unknown): ModelTier | undefined {
  return value === 'fast' || value === 'balanced' || value === 'powerful' ? value : undefined;
}

/**
 * `model-override: <provider>/<model>` → 结构化。按第一个斜杠切分，
 * 因为模型名本身可能带斜杠（如 openrouter 的 `anthropic/claude-x`）。
 */
function modelOverrideValue(value: unknown): { provider: string; model: string } | undefined {
  const raw = stringValue(value);
  const slash = raw ? raw.indexOf('/') : -1;
  if (!raw || slash <= 0 || slash === raw.length - 1) return undefined;
  return { provider: raw.slice(0, slash).trim(), model: raw.slice(slash + 1).trim() };
}

function proactivityLevelValue(value: unknown): RoleProactivityLevel | undefined {
  return value === 'silent' || value === 'daily' || value === 'realtime' ? value : undefined;
}

const SKILL_CATEGORIES: ReadonlySet<SkillCategory> = new Set([
  'docs-office', 'data-analysis', 'design-creative', 'content-marketing',
  'product', 'research', 'automation', 'development',
]);

function roleVisualFromFrontmatter(frontmatter: Record<string, unknown>): RoleVisual {
  const category = stringValue(frontmatter.category);
  return {
    ...(stringValue(frontmatter['display-name']) ? { displayName: stringValue(frontmatter['display-name']) } : {}),
    ...(stringValue(frontmatter.profession) ? { profession: stringValue(frontmatter.profession) } : {}),
    ...(stringValue(frontmatter.icon) ? { icon: stringValue(frontmatter.icon) } : {}),
    ...(category && SKILL_CATEGORIES.has(category as SkillCategory) ? { category: category as SkillCategory } : {}),
    ...(stringArrayValue(frontmatter.tags) ? { tags: stringArrayValue(frontmatter.tags) } : {}),
    ...(stringArrayValue(frontmatter['quick-prompts']) ? { quickPrompts: stringArrayValue(frontmatter['quick-prompts']) } : {}),
  };
}

/** 只读取展示层白名单；未知 frontmatter 对运行时和写回都保持透明。 */
export function parseAgentMdVisual(content: string): RoleVisual {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return frontmatterMatch ? roleVisualFromFrontmatter(parseSimpleYaml(frontmatterMatch[1])) : {};
}

function scalar(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim();
}

function block(key: string, values: string[], newline: string): string {
  return values.length === 0
    ? ''
    : `${key}:${newline}${values.map((value) => `  - ${scalar(value)}`).join(newline)}`;
}

/**
 * 只改展示层白名单，保留 frontmatter 的顺序、未知 key 和正文原文。
 * tags / quick-prompts 强制块状数组，避免 simple YAML parser 将中文逗号拆断。
 */
export function updateAgentMdVisual(content: string, visual: RoleVisual): string {
  const match = content.match(/^(---)(\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
  if (!match) throw new Error('Invalid agent definition: missing frontmatter');
  const [, opening, newline, rawFrontmatter, closing, body] = match;
  let frontmatter = rawFrontmatter;
  const replacements: Array<[string, string]> = [
    ['display-name', visual.displayName ? `display-name: ${scalar(visual.displayName)}` : ''],
    ['profession', visual.profession ? `profession: ${scalar(visual.profession)}` : ''],
    ['icon', visual.icon ? `icon: ${scalar(visual.icon)}` : ''],
    ['category', visual.category ? `category: ${visual.category}` : ''],
    ['tags', block('tags', visual.tags ?? [], newline)],
    ['quick-prompts', block('quick-prompts', visual.quickPrompts ?? [], newline)],
  ];
  for (const [key, replacement] of replacements) {
    const expression = new RegExp(`(^|\\r?\\n)${key}:.*(?:\\r?\\n[ \\t]+-.*)*`, 'm');
    if (expression.test(frontmatter)) {
      frontmatter = frontmatter.replace(expression, (_matched, prefix: string) => replacement ? `${prefix}${replacement}` : '');
    } else if (replacement) {
      frontmatter += `${frontmatter ? newline : ''}${replacement}`;
    }
  }
  // 删除字段后留下的空白行只限于刚才删掉的位置，不触碰其它字段顺序或正文。
  frontmatter = frontmatter.replace(/(?:\r?\n){3,}/g, `${newline}${newline}`);
  return `${opening}${newline}${frontmatter}${closing}${body}`;
}

export interface AgentMdEquipment {
  skills: string[];
  tools: string[];
  model: ModelTier;
  /** 指定具体模型；缺省或留空表示跟随 model 档位（写回时会删掉这行）。 */
  modelOverride?: { provider: string; model: string } | null;
  maxIterations: number;
}

/** 只改装备层白名单，保留其它 frontmatter 字段的顺序、未知 key 和正文原文。 */
export function updateAgentMdEquipment(content: string, equipment: AgentMdEquipment): string {
  const match = content.match(/^(---)(\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
  if (!match) throw new Error('Invalid agent definition: missing frontmatter');
  const [, opening, newline, rawFrontmatter, closing, body] = match;
  let frontmatter = rawFrontmatter;
  const replacements: Array<[string, string]> = [
    ['skills', block('skills', equipment.skills, newline)],
    ['tools', block('tools', equipment.tools, newline)],
    ['model', `model: ${equipment.model}`],
    // 空串会让下面的替换逻辑删掉这一行 —— 取消指定模型即回到档位。
    ['model-override', equipment.modelOverride
      ? `model-override: ${scalar(equipment.modelOverride.provider)}/${scalar(equipment.modelOverride.model)}`
      : ''],
    ['max-iterations', `max-iterations: ${equipment.maxIterations}`],
  ];
  for (const [key, replacement] of replacements) {
    const expression = new RegExp(`(^|\\r?\\n)${key}:.*(?:\\r?\\n[ \\t]+-.*)*`, 'm');
    if (expression.test(frontmatter)) {
      frontmatter = frontmatter.replace(expression, (_matched, prefix: string) => replacement ? `${prefix}${replacement}` : '');
    } else if (replacement) {
      frontmatter += `${frontmatter ? newline : ''}${replacement}`;
    }
  }
  frontmatter = frontmatter.replace(/(?:\r?\n){3,}/g, `${newline}${newline}`);
  return `${opening}${newline}${frontmatter}${closing}${body}`;
}

/** 只替换 frontmatter 之后的正文，frontmatter（含换行风格）逐字保留。 */
export function updateAgentMdBody(content: string, body: string): string {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n)[\s\S]*$/);
  if (!match) throw new Error('Invalid agent definition: missing frontmatter');
  return `${match[1]}${match[2]}${body}`;
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

  const name = stringValue(frontmatter.name) || path.basename(filename, '.md');
  const description = stringValue(frontmatter.description);

  // 角色主动性（内部文档 §4）：扁平 key 适配 simple YAML parser
  const proactivityLevel = proactivityLevelValue(frontmatter['proactivity-level']);
  const proactivityCadence = stringValue(frontmatter['proactivity-cadence']);

  return {
    id: name as CoreAgentId,
    name,
    description: description || `Custom agent: ${name}`,
    prompt,
    tools: stringArrayValue(frontmatter.tools) || ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    // GAP-011：skills 字段（课程"方向 A"）——预装 skill 全文注入子代理 system prompt
    skills: stringArrayValue(frontmatter.skills),
    inputs: nonEmptyStringArrayValue(frontmatter.inputs),
    outputs: nonEmptyStringArrayValue(frontmatter.outputs),
    model: modelTierValue(frontmatter.model) || 'balanced',
    ...(modelOverrideValue(frontmatter['model-override'])
      ? { modelOverride: modelOverrideValue(frontmatter['model-override']) }
      : {}),
    maxIterations: numberValue(frontmatter['max-iterations']) || 30,
    readonly: booleanValue(frontmatter.readonly) ?? false,
    ...(proactivityLevel
      ? { proactivity: { level: proactivityLevel, ...(proactivityCadence ? { cadence: proactivityCadence } : {}) } }
      : {}),
    visual: roleVisualFromFrontmatter(frontmatter),
  };
}

/**
 * Simple YAML parser for frontmatter.
 * Handles key: value pairs and key: [array] / key:\n  - item syntax.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
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
