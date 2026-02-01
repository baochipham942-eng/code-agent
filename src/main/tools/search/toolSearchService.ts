// ============================================================================
// ToolSearchService - 工具搜索服务
// ============================================================================

import type {
  ToolSearchResult,
  ToolSearchItem,
  ToolSearchOptions,
  DeferredToolMeta,
  ToolSearchQueryMode,
} from '../../../shared/types/toolSearch';
import type { GenerationId } from '../../../shared/types/generation';
import { DEFERRED_TOOLS_META, buildDeferredToolIndex, isCoreToolName } from './deferredTools';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ToolSearchService');

/**
 * ToolSearchService - 工具搜索和延迟加载管理
 *
 * 核心功能：
 * - 关键字搜索：根据名称、描述、标签、别名匹配工具
 * - 直接选择：通过 "select:tool_name" 直接加载指定工具
 * - 必须前缀：通过 "+keyword search" 强制匹配某关键字
 * - 延迟加载管理：跟踪已加载的延迟工具
 */
export class ToolSearchService {
  private loadedDeferredTools: Set<string> = new Set();
  private deferredToolIndex: Map<string, DeferredToolMeta>;
  private mcpToolsMeta: Map<string, DeferredToolMeta> = new Map();
  private skillsMeta: Map<string, DeferredToolMeta> = new Map();

  constructor() {
    this.deferredToolIndex = buildDeferredToolIndex();
    logger.debug(`Initialized with ${this.deferredToolIndex.size} deferred tools`);
  }

  /**
   * 解析搜索查询模式
   *
   * 支持格式：
   * - "pdf" → 关键字搜索
   * - "select:web_fetch" → 直接选择
   * - "+mcp search" → 必须匹配 "mcp"，按 "search" 排序
   */
  parseQuery(query: string): ToolSearchQueryMode {
    const trimmed = query.trim();

    // 直接选择模式
    if (trimmed.startsWith('select:')) {
      const toolName = trimmed.slice(7).trim();
      return { type: 'select', toolName };
    }

    // 必须前缀模式
    if (trimmed.startsWith('+')) {
      const parts = trimmed.slice(1).trim().split(/\s+/);
      const requiredWord = parts[0]?.toLowerCase() || '';
      const keywords = parts.slice(1).map(k => k.toLowerCase());
      return { type: 'required', requiredWord, keywords };
    }

    // 普通关键字搜索
    const keywords = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    return { type: 'keyword', keywords };
  }

  /**
   * 搜索工具
   */
  async searchTools(
    query: string,
    options: ToolSearchOptions = {}
  ): Promise<ToolSearchResult> {
    const { maxResults = 5, generationId, includeMCP = true } = options;
    const mode = this.parseQuery(query);

    logger.debug(`Searching tools: query="${query}", mode=${mode.type}`);

    // 直接选择模式
    if (mode.type === 'select') {
      return this.selectTool(mode.toolName, generationId);
    }

    // 获取所有可搜索的工具元数据
    const allTools = this.getAllSearchableTools(generationId, includeMCP);

    // 计算匹配分数
    const scored: Array<{ meta: DeferredToolMeta; score: number }> = [];

    for (const meta of allTools) {
      let score = 0;

      if (mode.type === 'required') {
        // 必须包含指定关键字
        const hasRequired = this.matchesKeyword(meta, mode.requiredWord);
        if (!hasRequired) continue;

        score = 0.5; // 基础分
        for (const keyword of mode.keywords) {
          score += this.calculateKeywordScore(meta, keyword);
        }
      } else {
        // 普通关键字搜索
        for (const keyword of mode.keywords) {
          score += this.calculateKeywordScore(meta, keyword);
        }
      }

      if (score > 0) {
        scored.push({ meta, score });
      }
    }

    // 按分数排序
    scored.sort((a, b) => b.score - a.score);

    // 取 top N
    const topResults = scored.slice(0, maxResults);
    const loadedTools: string[] = [];

    const tools: ToolSearchItem[] = topResults.map(({ meta, score }) => {
      // 标记为已加载
      this.loadedDeferredTools.add(meta.name);
      loadedTools.push(meta.name);

      return {
        name: meta.name,
        description: meta.shortDescription,
        score: Math.min(score, 1),
        source: meta.source,
        mcpServer: meta.mcpServer,
        tags: meta.tags,
      };
    });

    logger.info(`Found ${scored.length} matches, returning ${tools.length}, loaded: ${loadedTools.join(', ')}`);

    return {
      tools,
      hasMore: scored.length > maxResults,
      totalCount: scored.length,
      loadedTools,
    };
  }

  /**
   * 直接选择工具
   */
  selectTool(toolName: string, generationId?: GenerationId): ToolSearchResult {
    const meta = this.deferredToolIndex.get(toolName) || this.mcpToolsMeta.get(toolName);

    if (!meta) {
      logger.warn(`Tool not found: ${toolName}`);
      return {
        tools: [],
        hasMore: false,
        totalCount: 0,
        loadedTools: [],
      };
    }

    // 检查代际兼容性
    if (generationId && !meta.generations.includes(generationId)) {
      logger.warn(`Tool ${toolName} not available for generation ${generationId}`);
      return {
        tools: [],
        hasMore: false,
        totalCount: 0,
        loadedTools: [],
      };
    }

    // 标记为已加载
    this.loadedDeferredTools.add(meta.name);
    logger.info(`Selected and loaded tool: ${toolName}`);

    return {
      tools: [{
        name: meta.name,
        description: meta.shortDescription,
        score: 1,
        source: meta.source,
        mcpServer: meta.mcpServer,
        tags: meta.tags,
      }],
      hasMore: false,
      totalCount: 1,
      loadedTools: [meta.name],
    };
  }

  /**
   * 注册 MCP 工具元数据
   */
  registerMCPTool(meta: DeferredToolMeta): void {
    this.mcpToolsMeta.set(meta.name, meta);
    logger.debug(`Registered MCP tool: ${meta.name} from ${meta.mcpServer}`);
  }

  /**
   * 批量注册 MCP 工具
   */
  registerMCPTools(metas: DeferredToolMeta[]): void {
    for (const meta of metas) {
      this.registerMCPTool(meta);
    }
    logger.info(`Registered ${metas.length} MCP tools`);
  }

  /**
   * 注册 Skill 元数据
   * Skill 作为虚拟工具注册，便于通过 tool_search 发现
   */
  registerSkill(name: string, description: string): void {
    const meta: DeferredToolMeta = {
      name: `skill:${name}`,
      shortDescription: description,
      tags: ['planning'],
      aliases: [name],
      source: 'dynamic',
      generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
    };
    this.skillsMeta.set(meta.name, meta);
    logger.debug(`Registered skill: ${name}`);
  }

  /**
   * 批量注册 Skills
   */
  registerSkills(skills: Array<{ name: string; description: string }>): void {
    for (const skill of skills) {
      this.registerSkill(skill.name, skill.description);
    }
    logger.info(`Registered ${skills.length} skills`);
  }

  /**
   * 清除已注册的 Skills（用于刷新）
   */
  clearSkills(): void {
    this.skillsMeta.clear();
    logger.debug('Cleared all registered skills');
  }

  /**
   * 获取已加载的延迟工具名称
   */
  getLoadedDeferredTools(): string[] {
    return Array.from(this.loadedDeferredTools);
  }

  /**
   * 检查工具是否已加载
   */
  isToolLoaded(name: string): boolean {
    // 核心工具始终视为已加载
    if (isCoreToolName(name)) return true;
    return this.loadedDeferredTools.has(name);
  }

  /**
   * 重置加载状态（新会话时调用）
   */
  resetLoadedTools(): void {
    this.loadedDeferredTools.clear();
    logger.debug('Reset loaded deferred tools');
  }

  /**
   * 获取延迟工具摘要（用于 system prompt）
   */
  getDeferredToolsSummary(generationId?: GenerationId): string {
    const allTools = this.getAllSearchableTools(generationId, true);
    const names = allTools.map(t => t.name);
    return names.join('\n');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 获取所有可搜索的工具元数据
   */
  private getAllSearchableTools(
    generationId?: GenerationId,
    includeMCP = true
  ): DeferredToolMeta[] {
    const result: DeferredToolMeta[] = [];

    // 添加内置延迟工具
    for (const meta of DEFERRED_TOOLS_META) {
      if (!generationId || meta.generations.includes(generationId)) {
        result.push(meta);
      }
    }

    // 添加 MCP 工具
    if (includeMCP) {
      for (const meta of this.mcpToolsMeta.values()) {
        if (!generationId || meta.generations.includes(generationId)) {
          result.push(meta);
        }
      }
    }

    // 添加 Skills
    for (const meta of this.skillsMeta.values()) {
      if (!generationId || meta.generations.includes(generationId)) {
        result.push(meta);
      }
    }

    return result;
  }

  /**
   * 检查是否匹配关键字
   */
  private matchesKeyword(meta: DeferredToolMeta, keyword: string): boolean {
    const lowerKeyword = keyword.toLowerCase();

    // 名称匹配
    if (meta.name.toLowerCase().includes(lowerKeyword)) return true;

    // 描述匹配
    if (meta.shortDescription.toLowerCase().includes(lowerKeyword)) return true;

    // 标签匹配
    if (meta.tags.some(tag => tag.toLowerCase().includes(lowerKeyword))) return true;

    // 别名匹配
    if (meta.aliases.some(alias => alias.toLowerCase().includes(lowerKeyword))) return true;

    // MCP 服务器名称匹配
    if (meta.mcpServer?.toLowerCase().includes(lowerKeyword)) return true;

    return false;
  }

  /**
   * 计算关键字匹配分数
   */
  private calculateKeywordScore(meta: DeferredToolMeta, keyword: string): number {
    const lowerKeyword = keyword.toLowerCase();
    let score = 0;

    // 名称完全匹配（最高分）
    if (meta.name.toLowerCase() === lowerKeyword) {
      score += 1.0;
    } else if (meta.name.toLowerCase().includes(lowerKeyword)) {
      score += 0.6;
    }

    // 别名完全匹配
    if (meta.aliases.some(a => a.toLowerCase() === lowerKeyword)) {
      score += 0.8;
    } else if (meta.aliases.some(a => a.toLowerCase().includes(lowerKeyword))) {
      score += 0.4;
    }

    // 标签匹配
    if (meta.tags.some(t => t.toLowerCase() === lowerKeyword)) {
      score += 0.5;
    }

    // 描述匹配
    if (meta.shortDescription.toLowerCase().includes(lowerKeyword)) {
      score += 0.3;
    }

    // MCP 服务器名称匹配
    if (meta.mcpServer?.toLowerCase().includes(lowerKeyword)) {
      score += 0.4;
    }

    return score;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalToolSearchService: ToolSearchService | null = null;

/**
 * 获取全局 ToolSearchService 实例
 */
export function getToolSearchService(): ToolSearchService {
  if (!globalToolSearchService) {
    globalToolSearchService = new ToolSearchService();
  }
  return globalToolSearchService;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetToolSearchService(): void {
  globalToolSearchService = null;
}
