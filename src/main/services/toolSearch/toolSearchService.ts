// ============================================================================
// ToolSearchService - 工具搜索服务
// ============================================================================

import type {
  ToolSearchResult,
  ToolSearchItem,
  ToolSearchOptions,
  DeferredToolMeta,
  ToolSearchQueryMode,
} from '../../../shared/contract/toolSearch';
import { DEFERRED_TOOLS_META, buildDeferredToolIndex, isCoreToolName } from './deferredTools';
import { createLogger } from '../infra/logger';
import { isProtocolToolName } from '../../tools/protocolRegistry';

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
    const { maxResults = 5, includeMCP = true } = options;
    const mode = this.parseQuery(query);

    logger.debug(`Searching tools: query="${query}", mode=${mode.type}`);

    // 直接选择模式
    if (mode.type === 'select') {
      return this.selectTool(mode.toolName);
    }

    // 获取所有可搜索的工具元数据
    const allTools = this.getAllSearchableTools(includeMCP);

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
      const loadable = this.canExposeLoadedTool(meta);
      const notCallableReason = loadable ? undefined : this.getNotCallableReason(meta);
      const canonicalInvocation = this.getCanonicalInvocation(meta, loadable);

      if (loadable) {
        this.loadedDeferredTools.add(meta.name);
        loadedTools.push(meta.name);
      } else {
        logger.debug(`ToolSearch match is not loadable as a callable tool: ${meta.name}: ${notCallableReason}`);
      }

      return {
        name: meta.name,
        description: meta.shortDescription,
        score: Math.min(score, 1),
        source: meta.source,
        mcpServer: meta.mcpServer,
        tags: meta.tags,
        loadable,
        ...(notCallableReason ? { notCallableReason } : {}),
        ...(canonicalInvocation ? { canonicalInvocation } : {}),
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
  selectTool(toolName: string): ToolSearchResult {
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


    const loadable = this.canExposeLoadedTool(meta);
    const notCallableReason = loadable ? undefined : this.getNotCallableReason(meta);
    const canonicalInvocation = this.getCanonicalInvocation(meta, loadable);
    const loadedTools = loadable ? [meta.name] : [];
    if (loadedTools.length > 0) {
      this.loadedDeferredTools.add(meta.name);
      logger.info(`Selected and loaded tool: ${toolName}`);
    } else {
      logger.info(`Selected tool is searchable but not loadable as a callable tool: ${toolName}`);
    }

    return {
      tools: [{
        name: meta.name,
        description: meta.shortDescription,
        score: 1,
        source: meta.source,
        mcpServer: meta.mcpServer,
        tags: meta.tags,
        loadable,
        ...(notCallableReason ? { notCallableReason } : {}),
        ...(canonicalInvocation ? { canonicalInvocation } : {}),
      }],
      hasMore: false,
      totalCount: 1,
      loadedTools,
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
  getDeferredToolsSummary(): string {
    const allTools = this.getAllSearchableTools(true);
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
    includeMCP = true
  ): DeferredToolMeta[] {
    const result: DeferredToolMeta[] = [];

    for (const meta of DEFERRED_TOOLS_META) {
      result.push(meta);
    }

    if (includeMCP) {
      for (const meta of this.mcpToolsMeta.values()) {
        result.push(meta);
      }
    }

    for (const meta of this.skillsMeta.values()) {
      result.push(meta);
    }

    return result;
  }

  /**
   * ToolSearch 只能把下一轮真的能进入 tool definitions 的工具标为 loaded。
   * - builtin 必须有 protocol schema
   * - MCP 动态工具由 MCPToolRegistry 提供真实 ToolDefinition
   * - skill 等虚拟搜索项只返回结果，不制造可调用假象
   */
  private canExposeLoadedTool(meta: DeferredToolMeta): boolean {
    if (isCoreToolName(meta.name)) return true;
    if (meta.source === 'mcp') return this.mcpToolsMeta.has(meta.name);
    if (meta.source === 'builtin') return isProtocolToolName(meta.name);
    return false;
  }

  private getNotCallableReason(meta: DeferredToolMeta): string {
    if (meta.source === 'builtin') {
      return 'searchable metadata has no registered protocol tool';
    }
    if (meta.source === 'dynamic' && meta.name.startsWith('skill:')) {
      return 'skill search result; invoke through the Skill tool';
    }
    if (meta.source === 'mcp') {
      return 'MCP tool metadata is not registered with MCPClient';
    }
    return 'search-only result; no direct tool definition is available';
  }

  private getCanonicalInvocation(meta: DeferredToolMeta, loadable: boolean): string | undefined {
    if (meta.source === 'dynamic' && meta.name.startsWith('skill:')) {
      const skillName = meta.name.slice('skill:'.length);
      return `Skill({"command":"${skillName}"})`;
    }
    if (loadable) {
      return meta.name;
    }
    return undefined;
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

    // searchHint 匹配 (MCP 工具的语义搜索提示)
    if (meta.searchHint?.some(hint => hint.toLowerCase().includes(lowerKeyword))) return true;

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

    // searchHint 匹配 (语义搜索提示，权重高于描述)
    if (meta.searchHint?.some(h => h.toLowerCase() === lowerKeyword)) {
      score += 0.7;
    } else if (meta.searchHint?.some(h => h.toLowerCase().includes(lowerKeyword))) {
      score += 0.4;
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
