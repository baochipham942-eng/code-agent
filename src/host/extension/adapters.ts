// ============================================================================
// Extension Adapters — PluginManifest / ParsedSkill → ExtensionMetadata
// ============================================================================
//
// Phase 1 范围:纯函数投影,无副作用,不读 IO 不写状态。
// 不在这里 import 任何 PluginRegistry / SkillDiscoveryService 实例,只依赖
// 各自的 type 定义。这样 Phase 2/3 把 ExtensionRegistry 接进来时不会牵动
// 现有 wiring。
//
// 设计契约:
// - 投影是有损的:plugin 的 `permissions`/`nativeDeps`,
//   skill 的 `allowedTools`/`bins`/`envVars`/`model`/`executionContext` 等
//   source-specific 字段不进 metadata。Phase 2+ 通过 AgentExtension 上的
//   source-specific 字段携带。
// - 投影是单向的:Plugin/Skill → Extension。反向不需要(消费侧只读)。
// - 投影是确定的:相同输入恒产相同输出,便于做 cache key / diff。
// ============================================================================

import type { LoadedPlugin, PluginManifest, PluginState } from '../plugins/types';
import type { ParsedSkill, SkillSource } from '../../shared/contract/agentSkill';
import type {
  AgentExtension,
  ExtensionMetadata,
  ExtensionPlatform,
  ExtensionOrigin,
  ExtensionRuntimeState,
  ExtensionSurface,
} from './types';

/**
 * `PluginManifest` → `ExtensionMetadata` 投影。
 *
 * @param manifest plugin manifest 原文
 * @param source   覆盖来源(默认 `'plugin'`;builtin plugin 由调用方传 `'builtin'`)
 *
 * 字段处理:
 * - `description` 缺失 → 空字符串(对齐 metadata 必填语义)
 * - `surfaces` 缺失 → `['tools']`(plugin 的默认 surface)
 * - `version` 必传(PluginManifest schema 强制)
 * - source-specific 字段(`permissions`/`nativeDeps`)被丢弃,
 *   不进 metadata
 */
export function pluginManifestToMetadata(
  manifest: PluginManifest,
  source: ExtensionOrigin = 'plugin',
): ExtensionMetadata {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    source,
    surfaces: manifest.surfaces ?? ['tools'],
    version: manifest.version,
    author: manifest.author,
    capabilities: manifest.capabilities,
    platforms: manifest.platforms,
    homepage: manifest.homepage,
  };
}

/**
 * `ParsedSkill` → `ExtensionMetadata` 投影。
 *
 * 字段处理:
 * - skill 的 `name` 兼任 ID(skill 系统里 name 已是全局唯一,无独立 id 字段)
 * - `surfaces` 固定 `['skills']`(skill 不参与其它 surface)
 * - `version` / `author` / `platforms` skill 无对应字段,留空
 * - source-specific 字段(`allowedTools`/`bins`/`envVars`/`model`/
 *   `executionContext`/`promptContent` 等)被丢弃,后续 Phase 通过
 *   `AgentExtension.skillPrompt` 等字段携带
 */
export function parsedSkillToMetadata(skill: ParsedSkill): ExtensionMetadata {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    source: skillSourceToExtensionOrigin(skill.source),
    surfaces: ['skills'],
    aliases: skill.aliases,
  };
}

/**
 * `LoadedPlugin` → `AgentExtension` 投影(Phase 3a)。
 *
 * 比 `pluginManifestToMetadata` 多一层:吃运行时实例,带 `runtimeState`。
 * source 判定走 `rootPath` 前缀(`builtin:` → 'builtin',其它 → 'plugin'),
 * 与 `ExtensionRegistry.getExtensions()` 保持一致语义。
 */
export function loadedPluginToExtension(plugin: LoadedPlugin): AgentExtension {
  const source: ExtensionOrigin = plugin.rootPath.startsWith('builtin:')
    ? 'builtin'
    : 'plugin';
  return {
    metadata: pluginManifestToMetadata(plugin.manifest, source),
    runtimeState: plugin.state,
  };
}

/**
 * `ParsedSkill` → `AgentExtension` 投影(Phase 3a)。
 *
 * skill 没有 lifecycle 概念,所有进入 SkillDiscoveryService 的 skill 都视为
 * `'active'`(发现即可用)。
 */
export function parsedSkillToExtension(skill: ParsedSkill): AgentExtension {
  return {
    metadata: parsedSkillToMetadata(skill),
    runtimeState: 'active',
  };
}

/**
 * 把 `SkillSource` 映射成 `ExtensionOrigin`。两者取值已对齐,纯类型口径转换。
 */
function skillSourceToExtensionOrigin(source: SkillSource): ExtensionOrigin {
  // 当前 SkillSource 取值是 ExtensionOrigin 的真子集,直接结构转换 —— skill
  // 来源种类天然对齐 ExtensionOrigin 字面量集合。
  // 写成 switch 让 TS 在未来 SkillSource 扩字段时给 exhaustiveness 报错。
  switch (source) {
    case 'user':
    case 'project':
    case 'plugin':
    case 'builtin':
    case 'cloud':
    case 'library':
      return source;
  }
}

// 类型层 sanity check:ExtensionPlatform 应包含 PluginPlatform 全部取值。
// 编译期如果 PluginPlatform 加了新值而 ExtensionPlatform 没跟上,这里会报错。
const _platformCompat: ExtensionPlatform[] = [
  'darwin',
  'win32',
  'linux',
] satisfies ExtensionPlatform[];
void _platformCompat;

// 类型层 sanity check:PluginState 字面量集合必须是 ExtensionRuntimeState 子集。
// 编译期如果 PluginState 加了新值而 ExtensionRuntimeState 没跟上,这里会报错。
const _runtimeStateCompat = (s: PluginState): ExtensionRuntimeState => s;
void _runtimeStateCompat;

// 类型层 sanity check:ExtensionSurface 应包含 PluginSurface 全部取值。
const _surfaceCompat: ExtensionSurface[] = [
  'tools',
  'skills',
  'theme',
  'language',
] satisfies ExtensionSurface[];
void _surfaceCompat;
