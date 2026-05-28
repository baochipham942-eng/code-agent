// ============================================================================
// ExtensionRegistry skeleton 测试(D2 Phase 2)
// ============================================================================
// 覆盖:
//   - 空 sources → 空数组
//   - 只 plugins / 只 skills
//   - plugins + skills 混合聚合
//   - builtin plugin rootPath 推断 source='builtin'
//   - 第三方 plugin rootPath 推断 source='plugin'
//   - skill 各种 source 直接保留
//   - 排序:先 source 字典序,再 id 字典序
//   - 同 id 在两侧都出现 → 两条都返回(Phase 2 不合并语义)
//   - 多次调用相同 sources → 输出确定相等
//   - Mock minimum interface 即可,不必真的传 PluginRegistry/SkillDiscoveryService
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  ExtensionRegistry,
  type PluginsSource,
  type SkillsSource,
} from '../../../src/main/extension/extensionRegistry';
import type { LoadedPlugin, PluginManifest } from '../../../src/main/plugins/types';
import type { ParsedSkill, SkillSource } from '../../../src/shared/contract/agentSkill';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function makeManifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.js',
    ...overrides,
  };
}

function makePlugin(
  id: string,
  opts: { rootPath?: string; manifestOverrides?: Partial<PluginManifest> } = {},
): LoadedPlugin {
  return {
    manifest: makeManifest(id, opts.manifestOverrides),
    rootPath: opts.rootPath ?? `~/.code-agent/plugins/${id}`,
    state: 'active',
    registeredTools: [],
    registeredHooks: [],
  };
}

function makeSkill(name: string, source: SkillSource = 'user'): ParsedSkill {
  return {
    name,
    description: `desc of ${name}`,
    promptContent: '',
    basePath: `/skills/${name}`,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source,
  };
}

function pluginsFrom(plugins: LoadedPlugin[]): PluginsSource {
  return { getPlugins: () => plugins };
}

function skillsFrom(skills: ParsedSkill[]): SkillsSource {
  return { getAllSkills: () => skills };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('ExtensionRegistry skeleton', () => {
  it('空 sources → 空数组', () => {
    const reg = new ExtensionRegistry(pluginsFrom([]), skillsFrom([]));
    expect(reg.getExtensions()).toEqual([]);
  });

  it('只有 plugins → 投影成 AgentExtension[]', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([makePlugin('alpha'), makePlugin('beta')]),
      skillsFrom([]),
    );
    const result = reg.getExtensions();
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.metadata.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('只有 skills → 投影成 AgentExtension[]', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([]),
      skillsFrom([makeSkill('skill-a'), makeSkill('skill-b', 'project')]),
    );
    const result = reg.getExtensions();
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.metadata.surfaces[0])).toEqual(['skills', 'skills']);
  });

  it('plugins + skills 混合 → 都包含,数量正确', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([makePlugin('p1')]),
      skillsFrom([makeSkill('s1')]),
    );
    const result = reg.getExtensions();
    expect(result).toHaveLength(2);
    const ids = result.map((e) => e.metadata.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('s1');
  });

  it('builtin plugin rootPath(builtin: 前缀) → source="builtin"', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([makePlugin('image-process', { rootPath: 'builtin:image-process' })]),
      skillsFrom([]),
    );
    const result = reg.getExtensions();
    expect(result[0].metadata.source).toBe('builtin');
  });

  it('第三方 plugin rootPath(非 builtin: 前缀) → source="plugin"', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([makePlugin('third', { rootPath: '/home/u/.code-agent/plugins/third' })]),
      skillsFrom([]),
    );
    const result = reg.getExtensions();
    expect(result[0].metadata.source).toBe('plugin');
  });

  it('skill source 直接保留(builtin/user/project/plugin/library/cloud)', () => {
    const sources: SkillSource[] = ['builtin', 'user', 'project', 'plugin', 'library', 'cloud'];
    const reg = new ExtensionRegistry(
      pluginsFrom([]),
      skillsFrom(sources.map((s, i) => makeSkill(`skill-${i}`, s))),
    );
    const result = reg.getExtensions();
    const collected = result.map((e) => e.metadata.source);
    for (const s of sources) expect(collected).toContain(s);
  });

  it('排序:先 source 字典序,再 id 字典序', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([
        makePlugin('zeta', { rootPath: 'builtin:zeta' }),
        makePlugin('alpha', { rootPath: 'builtin:alpha' }),
        makePlugin('third', { rootPath: '/home/u/.code-agent/plugins/third' }),
      ]),
      skillsFrom([
        makeSkill('beta-skill', 'user'),
        makeSkill('alpha-skill', 'user'),
      ]),
    );
    const result = reg.getExtensions();
    const ordering = result.map((e) => `${e.metadata.source}:${e.metadata.id}`);
    expect(ordering).toEqual([
      'builtin:alpha',
      'builtin:zeta',
      'plugin:third',
      'user:alpha-skill',
      'user:beta-skill',
    ]);
  });

  it('同 id 在 plugins 和 skills 都出现 → 两条都返回(Phase 2 不合并)', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([makePlugin('dup')]),
      skillsFrom([makeSkill('dup')]),
    );
    const result = reg.getExtensions();
    expect(result).toHaveLength(2);
    const dupCount = result.filter((e) => e.metadata.id === 'dup').length;
    expect(dupCount).toBe(2);
    // 一条 source=plugin,一条 source=user(skill 默认)
    const sources = result.map((e) => e.metadata.source).sort();
    expect(sources).toEqual(['plugin', 'user']);
  });

  it('确定性:同 sources 多次调用产出相等结果', () => {
    const plugins = [makePlugin('a'), makePlugin('b')];
    const skills = [makeSkill('c'), makeSkill('d', 'project')];
    const reg = new ExtensionRegistry(pluginsFrom(plugins), skillsFrom(skills));
    expect(reg.getExtensions()).toEqual(reg.getExtensions());
  });

  it('mock minimum interface 即可工作(不需要真 PluginRegistry/SkillDiscoveryService)', () => {
    // 验证 PluginsSource / SkillsSource 真的是 minimum interface
    const fakePlugins: PluginsSource = {
      getPlugins: () => [],
    };
    const fakeSkills: SkillsSource = {
      getAllSkills: () => [],
    };
    const reg = new ExtensionRegistry(fakePlugins, fakeSkills);
    expect(() => reg.getExtensions()).not.toThrow();
  });

  it('plugin 完整字段投影到 metadata(version/author/capabilities/platforms)', () => {
    const reg = new ExtensionRegistry(
      pluginsFrom([
        makePlugin('rich', {
          rootPath: 'builtin:rich',
          manifestOverrides: {
            description: 'rich plugin',
            author: 'me',
            capabilities: ['image-gen'],
            platforms: ['darwin'],
          },
        }),
      ]),
      skillsFrom([]),
    );
    const m = reg.getExtensions()[0].metadata;
    expect(m.description).toBe('rich plugin');
    expect(m.author).toBe('me');
    expect(m.capabilities).toEqual(['image-gen']);
    expect(m.platforms).toEqual(['darwin']);
    expect(m.version).toBe('1.0.0');
  });
});
