// ============================================================================
// Generation Metadata - Only gen8 retained (Sprint 2: removed gen1-gen7)
// ============================================================================

import type { Generation, GenerationId } from '../../shared/types';

export const GENERATION_DEFINITIONS: Partial<Record<GenerationId, Omit<Generation, 'systemPrompt'>>> = {
  gen8: {
    id: 'gen8',
    name: '自我进化期',
    version: 'v8.0',
    description: 'Self-Evolution - 从经验中学习、自我优化和动态创建工具',
    tools: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'ListDirectory',
      'Task',
      'TodoWrite',
      'AskUserQuestion',
      'Skill',
      'WebFetch',
      'WebSearch',
      'ReadDocument',
      'MCPUnified',
      'memory_store',
      'memory_search',
      'code_index',
      'auto_learn',
      'Computer',
      'Browser',
      'AgentSpawn',
      'AgentMessage',
      'WorkflowOrchestrate',
      'strategy_optimize',
      'tool_create',
      'self_evaluate',
      'learn_pattern',
    ],
    promptMetadata: {
      lineCount: 400,
      toolCount: 35,
      ruleCount: 80,
    },
  },
};
