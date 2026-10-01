// ============================================================================
// frontend-slides / ppt — packaged skill directory, not an inline prompt.
// Both entries share one base path and one prompt. /ppt is a real skill name
// because slash matching compares skill.name, not aliases.
// ============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ParsedSkill } from '../../../shared/contract/agentSkill';
import { createLogger } from '../infra/logger';

const logger = createLogger('builtinFrontendSlides');

const SKILL_DIR_NAME = path.join('resources', 'skills', 'frontend-slides');
const MAX_PARENTS = 8;
const SKILL_DIR_TOKEN = '$SKILL_DIR';

const ALLOWED_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'glob',
  'grep',
  'ask_user_question',
  'image_generate',
  'read_pdf',
  'read_xlsx',
  'ReadDocument',
];

const MISSING_SKILL_PROMPT = [
  'The frontend-slides built-in is registered, but its packaged skill directory was not found.',
  'Tell the user the deck was not generated because the skill files are missing.',
  'Do not call ppt_generate. Do not retry image_generate.',
].join('\n');

interface FrontendSlidesRefreshOptions {
  cwd?: string;
  moduleDir?: string;
  resourceDir?: string;
  existsSync?: (targetPath: string) => boolean;
}

function createSkill(name: string, description: string): ParsedSkill {
  return {
    name,
    description,
    promptContent: MISSING_SKILL_PROMPT,
    basePath: '',
    allowedTools: [...ALLOWED_TOOLS],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: false,
    license: 'MIT',
    compatibility: 'code-agent >= 0.16',
  };
}

export const FRONTEND_SLIDES_BUILTIN_SKILLS: ParsedSkill[] = [
  createSkill(
    'frontend-slides',
    '使用图片化 slide deck 工作流生成高质量演示文稿，并输出 PPTX/PDF。没有图片模型时改为纯文字 deck。',
  ),
  createSkill(
    'ppt',
    '/ppt 兼容入口。与 frontend-slides 共用幻灯片工作流，输出 PPTX/PDF。没有图片模型时改为纯文字 deck。',
  ),
];

let cachedDefaultDir: string | null | undefined;
let warnedMissing = false;
const promptByDir = new Map<string, string>();

function defaultModuleDir(): string {
  if (typeof __dirname === 'string') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

function unique(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function parents(start: string): string[] {
  const result: string[] = [];
  let current = path.resolve(start);
  for (let i = 0; i < MAX_PARENTS; i += 1) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function skillDirCandidates(input: { resourceDir: string; moduleDir: string; cwd: string }): string[] {
  const candidates: string[] = [];
  if (input.resourceDir) {
    const root = path.resolve(input.resourceDir);
    candidates.push(path.join(root, '_up_', SKILL_DIR_NAME));
    candidates.push(path.join(root, SKILL_DIR_NAME));
    candidates.push(path.join(root, 'skills', 'frontend-slides'));
  }
  for (const start of [input.moduleDir, input.cwd]) {
    for (const dir of parents(start)) {
      candidates.push(path.join(dir, SKILL_DIR_NAME));
    }
  }
  return unique(candidates);
}

function resolveSkillDir(options: FrontendSlidesRefreshOptions | undefined, useEnv: boolean): string | null {
  const exists = options?.existsSync ?? fs.existsSync;
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  const resourceDir = useEnv
    ? (process.env.AGENT_NEO_RESOURCE_DIR?.trim() || processWithResources.resourcesPath?.trim() || '')
    : (options?.resourceDir?.trim() || '');
  const moduleDir = options?.moduleDir ?? defaultModuleDir();
  const cwd = options?.cwd ?? process.cwd();
  for (const dir of skillDirCandidates({ resourceDir, moduleDir, cwd })) {
    if (exists(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return (match ? match[1] : markdown).trim();
}

function loadPrompt(dir: string): string {
  const cached = promptByDir.get(dir);
  if (cached) return cached;
  const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const body = stripFrontmatter(raw).split(SKILL_DIR_TOKEN).join(dir);
  promptByDir.set(dir, body);
  return body;
}

function applyMissing(): void {
  for (const skill of FRONTEND_SLIDES_BUILTIN_SKILLS) {
    skill.basePath = '';
    skill.promptContent = MISSING_SKILL_PROMPT;
    skill.loaded = true;
  }
  if (!warnedMissing) {
    warnedMissing = true;
    logger.warn('frontend-slides packaged skill directory was not found');
  }
}

function applyResolved(dir: string | null): void {
  if (!dir) {
    applyMissing();
    return;
  }
  let prompt: string;
  try {
    prompt = loadPrompt(dir);
  } catch (error) {
    logger.warn('failed to read frontend-slides SKILL.md', { dir, error });
    applyMissing();
    return;
  }
  for (const skill of FRONTEND_SLIDES_BUILTIN_SKILLS) {
    skill.basePath = dir;
    skill.promptContent = prompt;
    skill.loaded = true;
  }
}

/**
 * Point both skills at the packaged directory.
 * An options object ignores AGENT_NEO_RESOURCE_DIR so tests can pin a layout.
 * The no-arg call reuses the first default resolution.
 */
export function refreshFrontendSlidesBasePath(options?: FrontendSlidesRefreshOptions): void {
  if (options) {
    applyResolved(resolveSkillDir(options, false));
    return;
  }
  if (cachedDefaultDir === undefined) {
    cachedDefaultDir = resolveSkillDir(undefined, true);
  }
  applyResolved(cachedDefaultDir);
}

refreshFrontendSlidesBasePath();
