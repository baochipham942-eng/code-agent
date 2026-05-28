// ============================================================================
// Extension Union — 公共扩展类型(Pi 借鉴 ⑤ D2 路径 Phase 1)
// ============================================================================
//
// 设计目标:
// 把 plugins / skills(以及未来可能并入的 hooks)抽象成单一 `AgentExtension`
// 形态,提供统一的 metadata 基类型和聚合视图。Phase 1 只定义类型 + 投影 adapter,
// 不接入任何运行时,旧 PluginRegistry / SkillDiscoveryService 完全不动。
//
// 后续 Phase:
//   - Phase 2: 实现 `ExtensionRegistry` skeleton,聚合 plugins + skills 投影
//   - Phase 3: 把 builtin plugin 生命周期 / SKILL.md 发现迁过来,旧入口改 thin wrapper
//   - Phase 3.5: Codex audit + follow-up
//
// 字段策略:
// - 公共 metadata 字段只保留双方都能合理映射的部分(id / name / description /
//   source / surfaces / version? / author? / capabilities? / platforms? /
//   aliases? / homepage?)
// - 各自独有的字段(plugin 的 `permissions`, `nativeDeps`, `generations`;
//   skill 的 `allowedTools`, `bins`, `envVars`, `executionContext`, `model` 等)
//   留在 source-specific 数据载体里,后续 Phase 通过 `AgentExtension` 的
//   `tools? / skillPrompt? / handlers?` 字段携带
// ============================================================================

/** 扩展暴露的 host surface */
export type ExtensionSurface = 'tools' | 'skills' | 'theme' | 'language' | 'hooks';

/**
 * 扩展来源种类。融合 plugin 和 skill 两侧的现有取值:
 * - `builtin`: 与 host 同 bundle(plugin 静态 import / skill builtin 目录)
 * - `user`: 用户级配置目录(`~/.code-agent/...`)
 * - `project`: 工程级配置目录(`<cwd>/.code-agent/...`)
 * - `plugin`: 由第三方 plugin 包提供的 skill
 * - `library`: skill marketplace / library
 * - `cloud`: 远程 cloud 来源
 */
export type ExtensionSource = 'builtin' | 'user' | 'project' | 'plugin' | 'library' | 'cloud';

/** 扩展声明支持的平台 */
export type ExtensionPlatform = 'darwin' | 'win32' | 'linux';

/**
 * 公共扩展元数据 —— `PluginManifest` 与 `ParsedSkill` 投影的统一形态。
 *
 * Phase 1 范围:仅作为只读视图供消费者(后续 ExtensionRegistry)读,不替代
 * 任何持久化或配置入口。
 */
export interface ExtensionMetadata {
  /** 全局唯一标识(plugin 用 manifest.id,skill 用 skill.name) */
  id: string;
  /** 展示名(用户面) */
  name: string;
  /** 描述,plugin 缺失时退化为空字符串以满足下游消费 */
  description: string;
  /** 来源种类 */
  source: ExtensionSource;
  /** 暴露的 host surface(必填,投影时按来源给默认值) */
  surfaces: ExtensionSurface[];
  /** semver 版本(skill 无版本概念时留空) */
  version?: string;
  /** 作者(skill 无作者字段时留空) */
  author?: string;
  /** 领域能力标签(plugin manifest 的 capabilities / skill 可在 metadata 携带) */
  capabilities?: string[];
  /** 支持的平台,空表示跨平台 */
  platforms?: ExtensionPlatform[];
  /** 别名(skill aliases / plugin 后续若加) */
  aliases?: string[];
  /** 主页或仓库 URL */
  homepage?: string;
}

/**
 * 统一扩展形态。
 *
 * Phase 1 只携带 metadata;Phase 2+ 会按需追加:
 * - `tools?: ToolModule[]`  原 plugin 工具注册
 * - `skillPrompt?: string`  原 ParsedSkill.promptContent
 * - `handlers?: HookDefinition[]`  可选 hook 配置
 * - `searchMeta?: DeferredToolMeta[]`  工具发现元数据
 */
export interface AgentExtension {
  metadata: ExtensionMetadata;
}
