// ============================================================================
// Agent Routing Service - Configuration-based Agent Routing
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { minimatch } from 'minimatch';
import type {
  AgentRoutingConfig,
  AgentBinding,
  RoutingContext,
  RoutingResolution,
  AgentsConfigFile,
} from '../../shared/types/agentRouting';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RoutingService');

// 默认配置版本
const CONFIG_VERSION = '1.0';

// 默认 Agent（无配置时使用）
const DEFAULT_AGENT: AgentRoutingConfig = {
  id: 'default',
  name: 'Default Agent',
  description: 'General-purpose AI assistant',
  systemPrompt: `You are a helpful AI assistant that helps with software engineering tasks.
Your responsibilities include:
- Understanding and explaining code
- Writing clean, efficient code
- Debugging and fixing issues
- Following best practices
- Providing clear explanations`,
  enabled: true,
  bindings: [{ type: 'always', match: {}, priority: -100 }],
  tags: ['general'],
};

/**
 * Agent 路由服务
 *
 * 负责根据上下文选择合适的 Agent 配置
 */
class RoutingService {
  private agents: Map<string, AgentRoutingConfig> = new Map();
  private defaultAgentId: string = 'default';
  private configPath: string = '';
  private initialized = false;

  /**
   * 初始化路由服务
   *
   * @param workingDirectory - 当前工作目录
   */
  async initialize(workingDirectory: string): Promise<void> {
    this.agents.clear();
    this.agents.set(DEFAULT_AGENT.id, DEFAULT_AGENT);

    // 1. 加载项目级配置 (.claude/agents.json)
    const projectConfigPath = path.join(workingDirectory, '.claude', 'agents.json');
    await this.loadConfigFile(projectConfigPath, 'project');

    // 2. 加载用户级配置 (~/.claude/agents.json)
    const userConfigPath = path.join(os.homedir(), '.claude', 'agents.json');
    await this.loadConfigFile(userConfigPath, 'user');

    // 3. 加载全局配置 (~/.code-agent/agents.json)
    const globalConfigPath = path.join(os.homedir(), '.code-agent', 'agents.json');
    this.configPath = globalConfigPath;
    await this.loadConfigFile(globalConfigPath, 'global');

    this.initialized = true;
    logger.info('Routing service initialized', {
      agentCount: this.agents.size,
      agents: Array.from(this.agents.keys()),
    });
  }

  /**
   * 加载配置文件
   */
  private async loadConfigFile(filePath: string, source: string): Promise<void> {
    try {
      await fs.access(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const config = JSON.parse(content) as AgentsConfigFile;

      if (config.agents) {
        for (const agent of config.agents) {
          if (agent.enabled !== false) {
            this.agents.set(agent.id, { ...agent, enabled: true });
            logger.debug('Loaded agent from config', {
              id: agent.id,
              source,
            });
          }
        }
      }

      if (config.defaultAgentId) {
        this.defaultAgentId = config.defaultAgentId;
      }
    } catch {
      // 配置文件不存在或解析失败
      logger.debug('Config file not found or invalid', { path: filePath });
    }
  }

  /**
   * 解析路由，根据上下文选择最佳 Agent
   *
   * @param context - 路由上下文
   * @returns 路由解析结果
   */
  resolve(context: RoutingContext): RoutingResolution {
    const candidates: RoutingResolution[] = [];

    for (const agent of this.agents.values()) {
      if (!agent.enabled) continue;

      const matchResult = this.matchAgent(agent, context);
      if (matchResult) {
        candidates.push(matchResult);
      }
    }

    // 按得分排序，选择最高分
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      logger.debug('Route resolved', {
        selected: candidates[0].agent.id,
        score: candidates[0].score,
        reason: candidates[0].reason,
        candidateCount: candidates.length,
      });
      return candidates[0];
    }

    // 无匹配时使用默认 Agent
    const defaultAgent = this.agents.get(this.defaultAgentId) || DEFAULT_AGENT;
    return {
      agent: defaultAgent,
      score: 0,
      reason: 'No specific agent matched, using default',
    };
  }

  /**
   * 匹配单个 Agent 的绑定规则
   */
  private matchAgent(
    agent: AgentRoutingConfig,
    context: RoutingContext
  ): RoutingResolution | null {
    if (!agent.bindings || agent.bindings.length === 0) {
      return null;
    }

    let bestMatch: { binding: AgentBinding; score: number; reason: string } | null = null;

    for (const binding of agent.bindings) {
      const result = this.matchBinding(binding, context);
      if (result.matched) {
        const score = (binding.priority || 0) + result.baseScore;
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { binding, score, reason: result.reason };
        }
      }
    }

    if (bestMatch) {
      return {
        agent,
        score: bestMatch.score,
        matchedBinding: bestMatch.binding,
        reason: bestMatch.reason,
      };
    }

    return null;
  }

  /**
   * 匹配单个绑定规则
   */
  private matchBinding(
    binding: AgentBinding,
    context: RoutingContext
  ): { matched: boolean; baseScore: number; reason: string } {
    const { type, match } = binding;
    let matched = false;
    let baseScore = 0;
    let reason = '';

    switch (type) {
      case 'always':
        matched = true;
        baseScore = 1;
        reason = 'Always match binding';
        break;

      case 'directory':
        if (match.directory) {
          matched = minimatch(context.workingDirectory, match.directory);
          if (matched) {
            baseScore = 10;
            reason = `Directory matches pattern: ${match.directory}`;
          }
        }
        break;

      case 'file_pattern':
        if (match.filePattern && context.activeFile) {
          matched = minimatch(context.activeFile, match.filePattern);
          if (matched) {
            baseScore = 15;
            reason = `File matches pattern: ${match.filePattern}`;
          }
        }
        break;

      case 'keyword':
        if (match.keywords && match.keywords.length > 0) {
          const lowerMessage = context.userMessage.toLowerCase();
          const matchedKeyword = match.keywords.find((kw) =>
            lowerMessage.includes(kw.toLowerCase())
          );
          if (matchedKeyword) {
            matched = true;
            baseScore = 20;
            reason = `Keyword matched: ${matchedKeyword}`;
          }
        }
        break;

      case 'intent':
        // 意图匹配需要语义分析，这里做简化处理
        // 实际实现可以调用 LLM 进行意图分类
        if (match.intent) {
          // 简单的关键词匹配作为 fallback
          const lowerMessage = context.userMessage.toLowerCase();
          const intentWords = match.intent.toLowerCase().split(/\s+/);
          const matchedWords = intentWords.filter((w) => lowerMessage.includes(w));
          if (matchedWords.length >= Math.min(2, intentWords.length)) {
            matched = true;
            baseScore = 25;
            reason = `Intent approximation matched: ${match.intent}`;
          }
        }
        break;
    }

    // 处理否定匹配
    if (match.negate) {
      matched = !matched;
      if (matched) {
        reason = `Negated: ${reason}`;
      }
    }

    return { matched, baseScore, reason };
  }

  /**
   * 获取所有 Agent 配置
   */
  getAllAgents(): AgentRoutingConfig[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取指定 Agent
   */
  getAgent(id: string): AgentRoutingConfig | undefined {
    return this.agents.get(id);
  }

  /**
   * 添加或更新 Agent
   */
  async upsertAgent(agent: AgentRoutingConfig): Promise<void> {
    this.agents.set(agent.id, agent);
    await this.saveConfig();
    logger.info('Agent upserted', { id: agent.id });
  }

  /**
   * 删除 Agent
   */
  async deleteAgent(id: string): Promise<boolean> {
    if (id === 'default') {
      logger.warn('Cannot delete default agent');
      return false;
    }

    const deleted = this.agents.delete(id);
    if (deleted) {
      await this.saveConfig();
      logger.info('Agent deleted', { id });
    }
    return deleted;
  }

  /**
   * 启用/禁用 Agent
   */
  async setAgentEnabled(id: string, enabled: boolean): Promise<void> {
    const agent = this.agents.get(id);
    if (agent) {
      agent.enabled = enabled;
      await this.saveConfig();
      logger.info('Agent enabled state changed', { id, enabled });
    }
  }

  /**
   * 设置默认 Agent
   */
  async setDefaultAgent(id: string): Promise<void> {
    if (this.agents.has(id)) {
      this.defaultAgentId = id;
      await this.saveConfig();
      logger.info('Default agent changed', { id });
    }
  }

  /**
   * 保存配置到文件
   */
  private async saveConfig(): Promise<void> {
    if (!this.configPath) return;

    const config: AgentsConfigFile = {
      version: CONFIG_VERSION,
      agents: Array.from(this.agents.values()).filter((a) => a.id !== 'default'),
      defaultAgentId: this.defaultAgentId,
      lastUpdated: Date.now(),
    };

    try {
      const dir = path.dirname(this.configPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
      logger.debug('Config saved', { path: this.configPath });
    } catch (error) {
      logger.error('Failed to save config', { error });
    }
  }

  /**
   * 重新加载配置
   */
  async reload(workingDirectory: string): Promise<void> {
    await this.initialize(workingDirectory);
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Global singleton
let globalInstance: RoutingService | null = null;

/**
 * 获取全局 RoutingService 实例
 */
export function getRoutingService(): RoutingService {
  if (!globalInstance) {
    globalInstance = new RoutingService();
  }
  return globalInstance;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetRoutingService(): void {
  globalInstance = null;
}

export { RoutingService };
