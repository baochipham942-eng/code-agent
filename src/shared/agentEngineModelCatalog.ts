import type { AgentEngineModelCatalog } from './contract/agentEngine';

const UPDATED_AT = '2026-05-25T00:00:00.000Z';

export const BUILTIN_AGENT_ENGINE_MODEL_CATALOG: AgentEngineModelCatalog = {
  version: 'builtin-2026-05-25',
  updatedAt: UPDATED_AT,
  engines: [
    {
      kind: 'codex_cli',
      defaultModel: 'gpt-5.5',
      updatedAt: UPDATED_AT,
      models: [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          capabilities: ['code', 'reasoning', 'longContext'],
          recommended: true,
          updatedAt: UPDATED_AT,
        },
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          capabilities: ['code', 'reasoning', 'longContext'],
          updatedAt: UPDATED_AT,
        },
        {
          id: 'gpt-5.4-mini',
          label: 'GPT-5.4 Mini',
          capabilities: ['code', 'fast', 'reasoning'],
          updatedAt: UPDATED_AT,
        },
        {
          id: 'gpt-5.3-codex',
          label: 'GPT-5.3 Codex',
          capabilities: ['code', 'reasoning', 'longContext'],
          updatedAt: UPDATED_AT,
        },
        {
          id: 'gpt-5.3-codex-spark',
          label: 'GPT-5.3 Codex Spark',
          capabilities: ['code', 'fast', 'reasoning'],
          updatedAt: UPDATED_AT,
        },
        {
          id: 'gpt-5.2',
          label: 'GPT-5.2',
          capabilities: ['code', 'reasoning', 'longContext'],
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
          label: 'Claude Sonnet (latest alias)',
          capabilities: ['code', 'reasoning', 'longContext'],
          recommended: true,
          updatedAt: UPDATED_AT,
        },
        {
          id: 'opus',
          label: 'Claude Opus (latest alias)',
          capabilities: ['code', 'reasoning', 'longContext'],
          updatedAt: UPDATED_AT,
        },
      ],
    },
  ],
};
