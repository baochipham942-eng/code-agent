// ============================================================================
// ExtensionRegistry — 统一扩展聚合视图(D2 Phase 2)
// ============================================================================
//
// 单一只读入口:把现有 PluginRegistry 和 SkillDiscoveryService 的活动实例
// 投影成 `AgentExtension[]`。本 Phase 不接入任何消费方,默认没人调,旧路径
// 完全不动。
//
// Phase 3 才会:
// - 把 builtin plugin 生命周期 / SKILL.md 发现迁过来,旧入口改 thin wrapper
// - 引入实际消费方(agentLoop / contextAssembly)
//
// 设计选择:
// - 构造函数注入(接口类型,非具体 class)便于测试 mock + 解耦
// - 不持有任何状态,每次 getExtensions() 都直接投影实时数据(plugins/skills
//   都是 in-memory 单例,读取廉价;避免 cache 带来的过期问题)
// - 不副作用,不写 IO,不变更上游 registry 状态
// ============================================================================

import { getPluginRegistry } from '../plugins/pluginRegistry';
import { getSkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import type { LoadedPlugin } from '../plugins/types';
import type { ParsedSkill } from '../../shared/contract/agentSkill';
import {
  pluginManifestToMetadata,
  parsedSkillToMetadata,
} from './adapters';
import type { AgentExtension, ExtensionSource } from './types';

/** 上游 plugin 数据源 minimum interface(仅依赖 getPlugins) */
export interface PluginsSource {
  getPlugins(): LoadedPlugin[];
}

/** 上游 skill 数据源 minimum interface(仅依赖 getAllSkills) */
export interface SkillsSource {
  getAllSkills(): ParsedSkill[];
}

/**
 * ExtensionRegistry —— 聚合 PluginRegistry + SkillDiscoveryService 的投影视图。
 *
 * 实例化方式:
 * - 生产代码用 `getExtensionRegistry()` 取 process 内单例
 * - 测试 / Phase 3 灰度场景 直接 `new ExtensionRegistry(fakePlugin, fakeSkill)`
 */
export class ExtensionRegistry {
  constructor(
    private readonly pluginsSource: PluginsSource,
    private readonly skillsSource: SkillsSource,
  ) {}

  /**
   * 聚合视图:plugins + skills 投影成统一 `AgentExtension[]`。
   *
   * 排序约定:先按 source 字典序(builtin → cloud → library → plugin → project
   * → user),再按 id 字典序。确定性排序有两个好处:
   * 1. 让 cache key / snapshot diff 稳定
   * 2. 让 LLM prompt cache 命中(若未来用作 tool 列表)
   *
   * 同名冲突约定(Phase 2):同一 id 在 plugins 和 skills 都出现时,两条都返回 —
   * 由消费方决定怎么处理。Phase 3 引入合并语义时再加约束。
   */
  getExtensions(): AgentExtension[] {
    const result: AgentExtension[] = [];

    for (const plugin of this.pluginsSource.getPlugins()) {
      const source: ExtensionSource = plugin.rootPath.startsWith('builtin:')
        ? 'builtin'
        : 'plugin';
      result.push({
        metadata: pluginManifestToMetadata(plugin.manifest, source),
      });
    }

    for (const skill of this.skillsSource.getAllSkills()) {
      result.push({
        metadata: parsedSkillToMetadata(skill),
      });
    }

    result.sort((a, b) => {
      if (a.metadata.source !== b.metadata.source) {
        return a.metadata.source.localeCompare(b.metadata.source);
      }
      return a.metadata.id.localeCompare(b.metadata.id);
    });

    return result;
  }
}

// ----------------------------------------------------------------------------
// Singleton 入口
// ----------------------------------------------------------------------------

let globalInstance: ExtensionRegistry | null = null;

/**
 * 获取 process 内单例 ExtensionRegistry,lazy 初始化,委托给已有的
 * `getPluginRegistry()` / `getSkillDiscoveryService()`。
 */
export function getExtensionRegistry(): ExtensionRegistry {
  if (!globalInstance) {
    globalInstance = new ExtensionRegistry(
      getPluginRegistry(),
      getSkillDiscoveryService(),
    );
  }
  return globalInstance;
}

/** 测试用:重置 process 内单例 */
export function resetExtensionRegistry(): void {
  globalInstance = null;
}
