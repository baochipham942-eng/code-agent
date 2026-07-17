// ============================================================================
// Extension adapters 单元测试(Phase 1)
// ============================================================================
// 覆盖:
//   - PluginManifest 全字段投影
//   - PluginManifest description 缺失 → 空字符串
//   - PluginManifest surfaces 缺失 → ['tools'] 默认
//   - PluginManifest 自定义 source(builtin / plugin)
//   - PluginManifest source-specific 字段(permissions/nativeDeps/main)被丢弃
//   - ParsedSkill 全字段投影
//   - ParsedSkill source 六种取值都转得过
//   - ParsedSkill surfaces 固定 ['skills']
//   - ParsedSkill source-specific 字段(promptContent/allowedTools/bins 等)被丢弃
//   - 同输入恒同输出(投影是纯函数)
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  pluginManifestToMetadata,
  parsedSkillToMetadata,
  loadedPluginToExtension,
  parsedSkillToExtension,
} from '../../../src/host/extension/adapters';
import type { LoadedPlugin, PluginManifest, PluginState } from '../../../src/host/plugins/types';
import type { ParsedSkill, SkillSource } from '../../../src/shared/contract/agentSkill';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function fullManifest(): PluginManifest {
  return {
    id: 'image-process',
    name: 'Image Process',
    version: '1.2.3',
    description: 'Process images',
    author: 'Agent Neo',
    homepage: 'https://example.com/image-process',
    main: 'index.js',
    surfaces: ['tools', 'language'],
    capabilities: ['image-processing', 'image-analysis'],
    platforms: ['darwin', 'linux'],
    permissions: ['filesystem', 'network'],
    nativeDeps: ['ffmpeg'],
  };
}

function fullSkill(source: SkillSource = 'user'): ParsedSkill {
  return {
    name: 'commit-helper',
    description: 'Write a conventional commit message',
    aliases: ['cm', 'commit'],
    license: 'MIT',
    metadata: { author: 'me' },
    promptContent: '# Commit Helper\n\nProvide a one-line subject ...',
    basePath: '/tmp/skills/commit-helper',
    allowedTools: ['Bash', 'Read'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source,
    bins: ['git'],
    envVars: ['HOME'],
    references: ['references/style.md'],
    loaded: true,
  };
}

// ----------------------------------------------------------------------------
// pluginManifestToMetadata
// ----------------------------------------------------------------------------

describe('pluginManifestToMetadata', () => {
  it('完整 manifest → metadata 全字段映射', () => {
    const result = pluginManifestToMetadata(fullManifest());
    expect(result).toEqual({
      id: 'image-process',
      name: 'Image Process',
      description: 'Process images',
      source: 'plugin',
      surfaces: ['tools', 'language'],
      version: '1.2.3',
      author: 'Agent Neo',
      capabilities: ['image-processing', 'image-analysis'],
      platforms: ['darwin', 'linux'],
      homepage: 'https://example.com/image-process',
    });
  });

  it('description 缺失 → 退化为空字符串(满足 metadata 必填语义)', () => {
    const manifest = fullManifest();
    delete manifest.description;
    const result = pluginManifestToMetadata(manifest);
    expect(result.description).toBe('');
  });

  it('surfaces 缺失 → 默认 ["tools"]', () => {
    const manifest = fullManifest();
    delete manifest.surfaces;
    const result = pluginManifestToMetadata(manifest);
    expect(result.surfaces).toEqual(['tools']);
  });

  it('source 默认 "plugin",builtin plugin 可覆盖为 "builtin"', () => {
    const manifest = fullManifest();
    expect(pluginManifestToMetadata(manifest).source).toBe('plugin');
    expect(pluginManifestToMetadata(manifest, 'builtin').source).toBe('builtin');
  });

  it('source-specific 字段(permissions/nativeDeps/main)不进 metadata', () => {
    const result = pluginManifestToMetadata(fullManifest()) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('permissions');
    expect(result).not.toHaveProperty('nativeDeps');
    expect(result).not.toHaveProperty('main');
  });

  it('可选字段全部缺失也能投影出来(只剩必填)', () => {
    const minimal: PluginManifest = {
      id: 'mini',
      name: 'Mini',
      version: '0.0.1',
      main: 'index.js',
    };
    const result = pluginManifestToMetadata(minimal);
    expect(result.id).toBe('mini');
    expect(result.name).toBe('Mini');
    expect(result.description).toBe('');
    expect(result.surfaces).toEqual(['tools']);
    expect(result.version).toBe('0.0.1');
    expect(result.author).toBeUndefined();
    expect(result.capabilities).toBeUndefined();
    expect(result.platforms).toBeUndefined();
    expect(result.homepage).toBeUndefined();
  });

  it('纯函数:同输入恒同输出', () => {
    const m = fullManifest();
    expect(pluginManifestToMetadata(m)).toEqual(pluginManifestToMetadata(m));
  });
});

// ----------------------------------------------------------------------------
// parsedSkillToMetadata
// ----------------------------------------------------------------------------

describe('parsedSkillToMetadata', () => {
  it('完整 skill → metadata 投影', () => {
    const result = parsedSkillToMetadata(fullSkill('user'));
    expect(result).toEqual({
      id: 'commit-helper',
      name: 'commit-helper',
      description: 'Write a conventional commit message',
      source: 'user',
      surfaces: ['skills'],
      aliases: ['cm', 'commit'],
    });
  });

  it('skill.name 兼任 ID(没有独立 id 字段)', () => {
    const result = parsedSkillToMetadata(fullSkill());
    expect(result.id).toBe(result.name);
  });

  it('SkillSource 六种取值全部能转(builtin/user/project/plugin/library/cloud)', () => {
    const sources: SkillSource[] = ['builtin', 'user', 'project', 'plugin', 'library', 'cloud'];
    for (const src of sources) {
      const result = parsedSkillToMetadata(fullSkill(src));
      expect(result.source).toBe(src);
    }
  });

  it('surfaces 固定 ["skills"](不参与 tools/theme/language)', () => {
    const result = parsedSkillToMetadata(fullSkill());
    expect(result.surfaces).toEqual(['skills']);
  });

  it('aliases 缺失 → 留空,不强行回填', () => {
    const skill = fullSkill();
    skill.aliases = undefined;
    const result = parsedSkillToMetadata(skill);
    expect(result.aliases).toBeUndefined();
  });

  it('source-specific 字段(promptContent/allowedTools/bins/envVars 等)不进 metadata', () => {
    const result = parsedSkillToMetadata(fullSkill()) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('promptContent');
    expect(result).not.toHaveProperty('basePath');
    expect(result).not.toHaveProperty('allowedTools');
    expect(result).not.toHaveProperty('bins');
    expect(result).not.toHaveProperty('envVars');
    expect(result).not.toHaveProperty('executionContext');
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('userInvocable');
  });

  it('skill 没 version/author/platforms 概念 → 留 undefined', () => {
    const result = parsedSkillToMetadata(fullSkill());
    expect(result.version).toBeUndefined();
    expect(result.author).toBeUndefined();
    expect(result.platforms).toBeUndefined();
  });

  it('纯函数:同输入恒同输出', () => {
    const s = fullSkill();
    expect(parsedSkillToMetadata(s)).toEqual(parsedSkillToMetadata(s));
  });
});

// ----------------------------------------------------------------------------
// loadedPluginToExtension (Phase 3a)
// ----------------------------------------------------------------------------

function makeLoadedPlugin(
  rootPath: string,
  state: PluginState = 'active',
  manifest: PluginManifest = fullManifest(),
): LoadedPlugin {
  return {
    manifest,
    rootPath,
    state,
    registeredTools: [],
    registeredHooks: [],
  };
}

describe('loadedPluginToExtension', () => {
  it('rootPath="builtin:..." → source="builtin"', () => {
    const ext = loadedPluginToExtension(makeLoadedPlugin('builtin:image-process'));
    expect(ext.metadata.source).toBe('builtin');
  });

  it('rootPath 非 builtin: 前缀 → source="plugin"', () => {
    const ext = loadedPluginToExtension(
      makeLoadedPlugin('/home/u/.code-agent/plugins/image-process'),
    );
    expect(ext.metadata.source).toBe('plugin');
  });

  it('runtimeState 直接取 LoadedPlugin.state', () => {
    const states: PluginState[] = ['active', 'inactive', 'activating', 'error', 'disabled'];
    for (const s of states) {
      const ext = loadedPluginToExtension(makeLoadedPlugin('builtin:p', s));
      expect(ext.runtimeState).toBe(s);
    }
  });

  it('metadata 字段与 pluginManifestToMetadata(builtin) 一致', () => {
    const plugin = makeLoadedPlugin('builtin:image-process');
    const ext = loadedPluginToExtension(plugin);
    expect(ext.metadata).toEqual(pluginManifestToMetadata(plugin.manifest, 'builtin'));
  });
});

// ----------------------------------------------------------------------------
// parsedSkillToExtension (Phase 3a)
// ----------------------------------------------------------------------------

describe('parsedSkillToExtension', () => {
  it('runtimeState 固定 "active"(skill 无 lifecycle 概念)', () => {
    const sources: SkillSource[] = ['builtin', 'user', 'project', 'plugin', 'library', 'cloud'];
    for (const src of sources) {
      const ext = parsedSkillToExtension(fullSkill(src));
      expect(ext.runtimeState).toBe('active');
    }
  });

  it('metadata 字段与 parsedSkillToMetadata 一致', () => {
    const skill = fullSkill('user');
    const ext = parsedSkillToExtension(skill);
    expect(ext.metadata).toEqual(parsedSkillToMetadata(skill));
  });
});

// ----------------------------------------------------------------------------
// 跨 adapter 一致性
// ----------------------------------------------------------------------------

describe('Plugin 和 Skill 投影到统一 ExtensionMetadata 形态', () => {
  it('两个 adapter 产出的对象都包含必填字段:id/name/description/source/surfaces', () => {
    const plugin = pluginManifestToMetadata(fullManifest());
    const skill = parsedSkillToMetadata(fullSkill());
    for (const m of [plugin, skill]) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.name).toBe('string');
      expect(typeof m.description).toBe('string');
      expect(typeof m.source).toBe('string');
      expect(Array.isArray(m.surfaces)).toBe(true);
      expect(m.surfaces.length).toBeGreaterThan(0);
    }
  });

  it('Plugin 默认 surface 包含 tools;Skill 必含 skills(双方不会撞 surface)', () => {
    const plugin = pluginManifestToMetadata({
      id: 'p',
      name: 'P',
      version: '1.0.0',
      main: 'index.js',
    });
    const skill = parsedSkillToMetadata(fullSkill());
    expect(plugin.surfaces).toContain('tools');
    expect(skill.surfaces).toContain('skills');
  });
});
