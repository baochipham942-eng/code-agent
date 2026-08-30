// ============================================================================
// skillCapabilitySurface 测试
// 1) legacy 声明规范化（main #1472）：缺 depends/provides 的 skill 全部可注册
// 2) per-skill 隔离：单个坏 skill（声明非法 / 注册抛错 / key 冲突）只 warn 跳过
// ============================================================================

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/capability/capabilityLifecycleTrace', () => ({
  recordCapabilityLifecycle: vi.fn(),
}));

import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';
import { synchronizeSkillCapabilitySurface } from '../../../../src/host/services/skills/skillCapabilitySurface';
import { parseSkillMetadataOnly } from '../../../../src/host/services/skills/skillParser';
import { ToolSearchService } from '../../../../src/host/services/toolSearch';

const LEGACY_SKILL_NAMES = ['dream', 'lark-sheets', 'e2e-cdp', 'deploy-tauri-app'] as const;

describe('skill capability surface legacy declarations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-capability-surface-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('synchronizes all observed legacy skills without missing depends failures', async () => {
    const skills = await Promise.all(LEGACY_SKILL_NAMES.map(async (name) => {
      const skillDir = path.join(tmpDir, name);
      await fs.mkdir(skillDir);
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        ['---', `name: ${name}`, 'description: Legacy skill fixture', '---', '', 'Body.'].join('\n'),
        'utf-8',
      );
      return parseSkillMetadataOnly(skillDir, 'user');
    }));
    const toolSearch = new ToolSearchService();

    await synchronizeSkillCapabilitySurface(skills, toolSearch);

    for (const name of LEGACY_SKILL_NAMES) {
      const result = await toolSearch.searchTools(name, { maxResults: 10, includeMCP: false });
      expect(result.tools.map((tool) => tool.name)).toContain(`skill:${name}`);
    }
  });
});

function makeSkill(overrides: Partial<ParsedSkill> & { name: string }): ParsedSkill {
  return {
    description: `${overrides.name} description`,
    depends: [],
    provides: [`skill:${overrides.name}`],
    promptContent: '',
    basePath: `/tmp/${overrides.name}`,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    ...overrides,
  } as ParsedSkill;
}

function makeToolSearch() {
  const registered = new Set<string>();
  const toolSearch = {
    registerSkill: vi.fn((name: string) => { registered.add(name); }),
    unregisterSkill: vi.fn((name: string) => { registered.delete(name); }),
  } as unknown as ToolSearchService;
  return { toolSearch, registered };
}

describe('synchronizeSkillCapabilitySurface per-skill isolation', () => {
  it('skips a skill with an invalid capability declaration and registers the rest', async () => {
    const { toolSearch, registered } = makeToolSearch();
    const bad = makeSkill({ name: 'bad-skill', provides: ['not-namespaced'] });
    const good = makeSkill({ name: 'good-skill' });

    await expect(
      synchronizeSkillCapabilitySurface([bad, good], toolSearch),
    ).resolves.toBeUndefined();

    expect(registered.has('good-skill')).toBe(true);
    expect(registered.has('bad-skill')).toBe(false);
  });

  it('keeps registering when one skill conflicts on a provided capability key', async () => {
    const { toolSearch, registered } = makeToolSearch();
    const first = makeSkill({ name: 'first', provides: ['skill:first', 'skill:shared'] });
    const conflicting = makeSkill({ name: 'second', provides: ['skill:second', 'skill:shared'] });
    const independent = makeSkill({ name: 'third' });

    await expect(
      synchronizeSkillCapabilitySurface([first, conflicting, independent], toolSearch),
    ).resolves.toBeUndefined();

    expect(registered.has('first')).toBe(true);
    expect(registered.has('third')).toBe(true);
    expect(registered.has('second')).toBe(false);
  });

  it('keeps registering when one skill registration throws', async () => {
    const registered = new Set<string>();
    const toolSearch = {
      registerSkill: vi.fn((name: string) => {
        if (name === 'exploding-skill') throw new Error('registry exploded');
        registered.add(name);
      }),
      unregisterSkill: vi.fn((name: string) => { registered.delete(name); }),
    } as unknown as ToolSearchService;

    await expect(
      synchronizeSkillCapabilitySurface(
        [makeSkill({ name: 'exploding-skill' }), makeSkill({ name: 'calm-skill' })],
        toolSearch,
      ),
    ).resolves.toBeUndefined();

    expect(registered.has('calm-skill')).toBe(true);
    expect(registered.has('exploding-skill')).toBe(false);
  });

  it('loads dependency-ordered skills and skips dependents of skipped providers', async () => {
    const { toolSearch, registered } = makeToolSearch();
    const base = makeSkill({ name: 'base' });
    const dependent = makeSkill({ name: 'dependent', depends: ['skill:base'] });
    const orphan = makeSkill({ name: 'orphan', depends: ['skill:missing-provider'] });

    await expect(
      synchronizeSkillCapabilitySurface([dependent, base, orphan], toolSearch),
    ).resolves.toBeUndefined();

    expect(registered.has('base')).toBe(true);
    expect(registered.has('dependent')).toBe(true);
    expect(registered.has('orphan')).toBe(false);
  });
});
