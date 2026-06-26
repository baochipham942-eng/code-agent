// ============================================================================
// Hybrid Agent Architecture - 混合式多 Agent 架构（精简后）
// ============================================================================
//
// 历史上承载三层架构（核心角色 / 动态扩展 / Agent Swarm + 路由），Wave 2
// 清理（cleanup/wave2-hybrid）确认 Layer 2/3 全链路 0 外部消费者，连带
// dynamicFactory.ts、crossVerify.ts、agentSwarm.ts、taskRouter 的路由体系
// 一并删除。当前 barrel 仅暴露：
// - Layer 1 核心角色（coreAgents）
// - .agent.md 自定义 Agent 加载器（agentMdLoader）
// - 任务类型嗅探函数 analyzeTask（agentLoop / agentOrchestrator 在用）
// - intentClassifier 的 fast/slow 路径桥接
// ============================================================================

// Core Agents (Layer 1)
export {
  type CoreAgentId,
  type CoreAgentConfig,
  type ModelTier,
  CORE_AGENTS,
  CORE_AGENT_IDS,
  SUBAGENT_SUFFIXES,
  MODEL_CONFIG,
  getCoreAgent,
  getAgent,
  listCoreAgents,
  getModelConfig,
  getAgentModelConfig,
  isReadonlyAgent,
  isCoreAgent,
  validateAgentId,
  recommendCoreAgent,
  loadCustomAgents,
  getCustomAgentCache,
} from './coreAgents';

// Agent Markdown Loader
export { parseAgentMd, loadAgentMdFiles } from './agentMdLoader';

// Task Analyzer (analyzeTask 用于 agentLoop / agentOrchestrator 嗅探任务类型)
export {
  type TaskAnalysis,
  analyzeTask,
} from './taskRouter';

// Intent Classifier (hybrid fast/slow path for research detection)
export {
  type TaskIntent,
  classifyIntent,
} from '../../routing/intentClassifier';
