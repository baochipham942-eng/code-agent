// ============================================================================
// Child Context Builder - Builds child agent context from parent + config
// ============================================================================

import { buildProfilePrompt } from '../prompts/builder';

export interface ParentContext {
  rules: string[];
  memory: string[];
  hooks: unknown[];
  skills: string[];
  mcpConnections: unknown[];
  permissionMode: string; // 'default' | 'bypassPermissions' | 'acceptEdits' etc.
  availableTools: string[];
}

export interface ChildContextConfig {
  agentType: string;
  allowedTools: string[];
  mode?: string;
  readOnly?: boolean;
}

export interface ChildContext {
  prompt: string;
  toolPool: string[];
  permissions: {
    inherited: string[]; // permission flags inherited from parent
    canEscalate: boolean; // always false — child can't escalate beyond parent
  };
  hooks: unknown[];
  skills: string[];
  mcpConnections: unknown[];
  memory: string[];
}

export function buildChildContext(config: ChildContextConfig, parent: ParentContext): ChildContext {
  // 1. Prompt: use subagent profile with slim rules
  const slimRules = config.readOnly ? parent.rules.slice(0, 3) : parent.rules;
  const slimMemory = config.readOnly ? parent.memory.slice(-5) : parent.memory;
  const prompt = buildProfilePrompt('subagent', {
    rules: slimRules,
    memory: slimMemory,
    mode: config.mode,
  });

  // 2. Tool pool: intersection of config.allowedTools and parent.availableTools
  const parentToolSet = new Set(parent.availableTools);
  const toolPool = config.allowedTools.filter(t => parentToolSet.has(t));

  // 3. Permissions: inherit, never escalate
  const inherited: string[] = [];
  if (parent.permissionMode === 'bypassPermissions') inherited.push('bypassPermissions');
  if (parent.permissionMode === 'acceptEdits') inherited.push('acceptEdits');

  // 4. Hooks: inherit parent hooks (no override mechanism yet)
  const hooks = [...parent.hooks];

  // 5. Skills: inherit parent skills
  const skills = [...parent.skills];

  // 6. MCP: inherit parent connections
  const mcpConnections = [...parent.mcpConnections];

  return {
    prompt,
    toolPool,
    permissions: { inherited, canEscalate: false },
    hooks,
    skills,
    mcpConnections,
    memory: slimMemory,
  };
}
