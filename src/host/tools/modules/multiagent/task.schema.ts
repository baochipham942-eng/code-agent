// Schema-only file (P1 Wave 3 — multiagent native migration)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const taskSchema: ToolSchema = {
  name: 'Task',
  description: `SDK-compatible tool for delegating tasks to specialized agents.

Use this tool when you need a single agent to complete a task synchronously.

Available agent types: coder, reviewer, explore, plan, awaiter

Routing rules:
- Use nested spawn for tree-shaped work: investigation → implementation → review, staged refactors, recursive research, and parent-level synthesis. Nested spawn is for context offload, not parallel speedup; prefer 2-3 layers.
- Use parallel multi-agent mode through AgentSpawn when branches are independent and can run at the same time.
- Do not delegate a single fact lookup, known file location, direct symbol search, or a small known edit. Use local read/search/edit tools directly.

For advanced features (parallel execution, background mode, custom prompts, budget control),
use AgentSpawn instead.

Parameters:
- description: Short description of the task (3-5 words)
- prompt: Detailed task for the agent
- subagent_type: Agent type to use`,
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short task description (3-5 words)',
      },
      prompt: {
        type: 'string',
        description: 'Detailed task prompt',
      },
      subagent_type: {
        type: 'string',
        description: 'Agent type to use',
      },
    },
    required: ['prompt', 'subagent_type'],
  },
  category: 'multiagent',
  permissionLevel: 'execute',
};
