// 产品文案只能点名当前内置注册表里真实存在的 skill。
// 读源码窗口，而不是把禁用文案抽成常量（那会动 host 中文 error 基线）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { FEW_SHOT_EXAMPLES } from '../../../src/host/prompts/fewShotExamples';
import { REMINDERS } from '../../../src/host/prompts/systemReminders';
import { BUILTIN_SKILLS } from '../../../src/host/services/skills/builtinSkillsData';
import { DEFERRED_TOOLS_META } from '../../../src/host/services/toolSearch/deferredTools';
import { pptGenerateSchema } from '../../../src/host/tools/modules/network/pptGenerate.schema';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'use',
  'using',
  'legacy',
  'please',
  'default',
  'call',
  'skill',
  'or',
  'to',
]);

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found');
}

function readWindow(relativePath: string, marker: string, radius: number): string {
  const text = fs.readFileSync(path.join(repoRoot(), relativePath), 'utf8');
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`missing ${marker} in ${relativePath}`);
  return text.slice(Math.max(0, at - radius), at + radius);
}

function guidanceText(): string {
  const example = FEW_SHOT_EXAMPLES.find((item) => item.type === 'ppt_creation');
  if (!example) throw new Error('ppt_creation few-shot missing');
  const deferred = DEFERRED_TOOLS_META.find((tool) => tool.name === 'ppt_generate')?.shortDescription ?? '';
  return [
    readWindow('src/host/tools/modules/network/pptGenerate.ts', "code: 'TOOL_DISABLED'", 700),
    pptGenerateSchema.description,
    readWindow('src/host/tools/modules/network/pptEdit.ts', "case 'insert_slide'", 500),
    REMINDERS.PPT_FORMAT_SELECTION,
    example.assistantResponse,
    deferred,
  ].join('\n');
}

function extractSkillRefs(text: string): string[] {
  const found = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name || STOPWORDS.has(name)) return;
    if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name)) return;
    found.add(name);
  };
  // Slash commands only. Paths (`ppt/presentation.xml`) and closing tags
  // (`</system-reminder>`) also contain a slash and are not skill names.
  for (const match of text.matchAll(/(?:^|[\s"'`(])\/([a-z][a-z0-9-]*)/g)) add(match[1]);
  for (const match of text.matchAll(/command\s*[=:]\s*["']([a-z][a-z0-9-]*)["']/g)) add(match[1]);
  for (const match of text.matchAll(/`([a-z][a-z0-9-]*)`\s+skill/g)) add(match[1]);
  for (const match of text.matchAll(/(?:^|[^a-z0-9-])([a-z][a-z0-9-]*)\s+skill/g)) add(match[1]);
  for (const match of text.matchAll(/(?:改用|使用)\s+`?([a-z][a-z0-9-]*)`?/g)) add(match[1]);
  return [...found];
}

function registeredSkillNames(): Set<string> {
  const names = new Set<string>();
  for (const skill of BUILTIN_SKILLS) {
    names.add(skill.name);
    for (const alias of skill.aliases ?? []) names.add(alias);
  }
  return names;
}

describe('ppt guidance names only registered built-in skills', () => {
  it('fails when a guidance string names a skill that is not in the built-in registry', () => {
    const refs = extractSkillRefs(guidanceText());
    expect(refs).toEqual(expect.arrayContaining(['frontend-slides', 'ppt']));
    const unknown = refs.filter((name) => !registeredSkillNames().has(name));
    expect(unknown).toEqual([]);
  });

  it('can go red when a string names a skill outside the registry', () => {
    const refs = extractSkillRefs('use not-a-real-skill skill');
    expect(refs).toContain('not-a-real-skill');
    const unknown = refs.filter((name) => !registeredSkillNames().has(name));
    expect(unknown).toEqual(['not-a-real-skill']);
  });
});
