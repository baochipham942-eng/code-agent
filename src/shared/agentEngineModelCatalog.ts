import type { AgentEngineModelCatalog } from './contract/agentEngine';

const UPDATED_AT = '2026-05-22T00:00:00.000Z';

export const BUILTIN_AGENT_ENGINE_MODEL_CATALOG: AgentEngineModelCatalog = {
  version: 'builtin-2026-05-22',
  updatedAt: UPDATED_AT,
  engines: [
    {
      kind: 'codex_cli',
      defaultModel: 'gpt-5',
      updatedAt: UPDATED_AT,
      models: [
        {
          id: 'gpt-5',
          label: 'GPT-5',
          capabilities: ['code', 'reasoning', 'longContext'],
          recommended: true,
          updatedAt: UPDATED_AT,
        },
        {
          id: 'gpt-5-codex',
          label: 'GPT-5 Codex',
          capabilities: ['code', 'reasoning', 'longContext'],
          updatedAt: UPDATED_AT,
        },
        {
          id: 'o4-mini',
          label: 'o4-mini',
          capabilities: ['code', 'fast', 'reasoning'],
          updatedAt: UPDATED_AT,
        },
      ],
    },
    {
      kind: 'claude_code',
      defaultModel: 'sonnet',
      updatedAt: UPDATED_AT,
      models: [
        {
          id: 'sonnet',
          label: 'Claude Sonnet',
          capabilities: ['code', 'reasoning', 'longContext'],
          recommended: true,
          updatedAt: UPDATED_AT,
        },
        {
          id: 'opus',
          label: 'Claude Opus',
          capabilities: ['code', 'reasoning', 'longContext'],
          updatedAt: UPDATED_AT,
        },
      ],
    },
  ],
};
