// frontend-slides 随包内置：--bare 只看见产品技能，/ppt 打到同目录，
// dist/cli、dist/web、桌面 Resources 三种布局都能找到 SKILL.md。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/toolSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/toolSearch')>();
  return {
    ...actual,
    getToolSearchService: () => ({
      registerSkill: () => {},
      unregisterSkill: () => {},
      getMCPToolsMeta: () => [],
    }),
  };
});

import { SkillDiscoveryService } from '../../../../src/host/services/skills/skillDiscoveryService';
import { resolveSkillInvocationFromSkills } from '../../../../src/host/services/skills/skillInvocationResolver';
import {
  FRONTEND_SLIDES_BUILTIN_SKILLS,
  refreshFrontendSlidesBasePath,
} from '../../../../src/host/services/skills/builtinFrontendSlides';

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

function writePackagedSkill(skillDir: string, marker: string): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: frontend-slides',
      'description: layout fixture',
      '---',
      '',
      marker,
      'node "$SKILL_DIR/scripts/merge-to-pptx-hybrid.mjs"',
      '',
    ].join('\n'),
    'utf8',
  );
}

function skillByName(name: string) {
  const skill = FRONTEND_SLIDES_BUILTIN_SKILLS.find((item) => item.name === name);
  expect(skill, name).toBeDefined();
  return skill!;
}

describe('packaged frontend-slides builtin', () => {
  const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
  const previousHome = process.env.CODE_AGENT_HOME;
  let service: SkillDiscoveryService;
  let projectDir: string;

  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-bare-'));
    projectDir = path.join(root, 'project');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'skills', 'host-decoy-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'skills', 'host-decoy-skill', 'SKILL.md'),
      '---\nname: host-decoy-skill\ndescription: should stay invisible\n---\n\nnope\n',
      'utf8',
    );
    fs.mkdirSync(path.join(projectDir, '.code-agent', 'skills', 'project-decoy-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.code-agent', 'skills', 'project-decoy-skill', 'SKILL.md'),
      '---\nname: project-decoy-skill\ndescription: should stay invisible\n---\n\nnope\n',
      'utf8',
    );
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    process.env.CODE_AGENT_HOME = homeDir;
    service = new SkillDiscoveryService();
    service.setBuiltinOnly(true);
    await service.initialize(projectDir);
  });

  afterEach(() => {
    refreshFrontendSlidesBasePath();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    if (previousHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = previousHome;
    refreshFrontendSlidesBasePath();
  });

  it('discovers frontend-slides and ppt from the packaged directory in builtin-only mode', () => {
    const slides = service.getSkill('frontend-slides');
    const ppt = service.getSkill('ppt');
    expect(slides?.source).toBe('builtin');
    expect(ppt?.source).toBe('builtin');
    expect(slides?.basePath).toBeTruthy();
    expect(ppt?.basePath).toBe(slides?.basePath);
    expect(fs.existsSync(path.join(slides!.basePath, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(slides!.basePath, 'scripts', 'merge-to-pptx-hybrid.bundle.mjs'))).toBe(true);
    expect(service.getSkill('host-decoy-skill')).toBeUndefined();
    expect(service.getSkill('project-decoy-skill')).toBeUndefined();

    for (const skill of [slides!, ppt!]) {
      expect(skill.userInvocable).toBe(true);
      expect(skill.disableModelInvocation).toBe(false);
      expect(skill.loaded).toBe(true);
      expect(skill.allowedTools).toEqual(ALLOWED_TOOLS);
      expect(skill.aliases ?? []).toEqual([]);
      expect(skill.metadata?.category).toBe('docs-office');
      expect(skill.metadata?.keywords).toBeUndefined();
      expect(skill.promptContent).toContain('backgrounds were skipped');
      expect(skill.promptContent).toContain('禁止重试');
      expect(skill.promptContent).toContain(path.join(skill.basePath, 'scripts', 'merge-to-pptx-hybrid.mjs'));
      expect(skill.promptContent).not.toContain('$SKILL_DIR');
      expect(skill.promptContent).not.toContain('.claude');
      expect(skill.promptContent).not.toContain('.agents');
      expect(skill.promptContent).not.toContain('.Codex');
    }
    expect(ppt!.promptContent).toBe(slides!.promptContent);
    expect(service.getSkillsForContext().map((skill) => skill.name)).toEqual(
      expect.arrayContaining(['frontend-slides', 'ppt']),
    );
  });

  it('routes the /ppt slash command to the ppt skill and the same base path', () => {
    const invocation = resolveSkillInvocationFromSkills(
      '/ppt 用这份材料做一个 5 页 PPT',
      service.getUserInvocableSkills(),
    );
    expect(invocation?.matchKind).toBe('slash');
    expect(invocation?.skill.name).toBe('ppt');
    expect(invocation?.skill.basePath).toBe(service.getSkill('frontend-slides')?.basePath);
    expect(invocation?.skill.basePath).not.toBe('');
  });

  it('finds the skill by walking up from dist/cli and dist/web', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-layout-'));
    for (const [segment, marker] of [['cli', 'MARKER_DIST_CLI'], ['web', 'MARKER_DIST_WEB']] as const) {
      const moduleDir = path.join(root, segment, 'dist', segment);
      fs.mkdirSync(moduleDir, { recursive: true });
      const skillDir = path.join(root, segment, 'resources', 'skills', 'frontend-slides');
      writePackagedSkill(skillDir, marker);
      refreshFrontendSlidesBasePath({ moduleDir, cwd: moduleDir, resourceDir: '' });
      const slides = skillByName('frontend-slides');
      const ppt = skillByName('ppt');
      expect(slides.basePath).toBe(skillDir);
      expect(ppt.basePath).toBe(skillDir);
      expect(slides.promptContent).toContain(marker);
      expect(slides.promptContent).toContain(path.join(skillDir, 'scripts', 'merge-to-pptx-hybrid.mjs'));
      expect(slides.metadata?.category).toBe('docs-office');
    }
  });

  it('finds the skill under the desktop Resources directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-resources-'));
    const resourceDir = path.join(root, 'Resources');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const skillDir = path.join(resourceDir, 'resources', 'skills', 'frontend-slides');
    writePackagedSkill(skillDir, 'MARKER_RESOURCES');
    refreshFrontendSlidesBasePath({ resourceDir, moduleDir: empty, cwd: empty });
    const slides = skillByName('frontend-slides');
    expect(slides.basePath).toBe(skillDir);
    expect(slides.promptContent).toContain('MARKER_RESOURCES');
    expect(slides.promptContent).toContain(path.join(skillDir, 'scripts', 'merge-to-pptx-hybrid.mjs'));
  });

  it('keeps a stable fallback when the packaged directory is missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-missing-'));
    refreshFrontendSlidesBasePath({ cwd: empty, moduleDir: empty, resourceDir: '' });
    const slides = skillByName('frontend-slides');
    expect(slides.basePath).toBe('');
    expect(slides.loaded).toBe(true);
    expect(slides.promptContent).toContain('packaged skill directory was not found');
    expect(slides.promptContent).toContain('Do not retry image_generate');
    expect(slides.metadata?.category).toBe('docs-office');
  });
});
