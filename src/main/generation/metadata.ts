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
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'list_directory',
      'task',
      'todo_write',
      'ask_user_question',
      'skill',
      'web_fetch',
      'web_search',
      'read_pdf',
      'mcp',
      'mcp_list_tools',
      'mcp_list_resources',
      'mcp_read_resource',
      'mcp_get_status',
      'memory_store',
      'memory_search',
      'code_index',
      'auto_learn',
      'screenshot',
      'computer_use',
      'browser_navigate',
      'browser_action',
      'spawn_agent',
      'agent_message',
      'workflow_orchestrate',
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
