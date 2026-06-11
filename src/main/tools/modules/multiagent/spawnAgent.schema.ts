// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

const baseDescription = `Launch a sub-agent for a focused task. Sub-agents run in isolated sessions with their own context window and return only their final result to you.

## When to spawn (autonomous judgment)
Consider spawning sub-agents when:
- Task involves 3+ unrelated files/modules (parallel exploration)
- Need simultaneous coding and testing/review
- Need codebase research before modification (explorer → coder pipeline)
- Refactoring with multiple independent change points
- Broad exploration that would consume your context window

## Routing rules for nested vs parallel vs no spawn
- tree-shaped tasks such as investigation → implementation → review, staged refactors, recursive codebase research, and parent-level synthesis should use nested spawn. Nested spawn is for context offload, not parallel speedup; prefer 2-3 layers and keep each child output distilled.
- Independent work with no dependency between branches should use parallel multi-agent mode with parallel=true and an agents array.
- A single fact lookup, known file location, direct symbol search, or a small known edit should not spawn an agent. Use the local read/search/edit tools directly.

When NOT to spawn:
- Simple single-file reads — use read_file directly
- Searching for a specific definition — use glob/grep directly
- Quick config changes or information queries
- Urgent blocking work where you need the result immediately

## Delegation strategy
1. Plan first: analyze the task, identify critical path vs side-quests
2. Keep blocking work local — only delegate non-blocking parallel tasks
3. Subtasks must be concrete, self-contained, and non-overlapping
4. For code edits, assign disjoint file ownership per agent
5. Tell workers they are not alone — don't revert others' changes

## After delegation
- Minimize waiting — do meaningful non-overlapping work while agents run
- Don't redo what a sub-agent already did
- Review returned changes, then integrate or refine

## Parallel patterns
- Spawn multiple explorers in parallel for independent codebase questions
- Split implementation into disjoint file scopes for parallel workers
- Run reviewer in parallel with ongoing implementation

## Available roles
- explore (alias: explorer): Read-only codebase exploration. Fast and authoritative. Spawn multiple in parallel for independent questions. Trust their results without re-verification.
- coder: Implementation work. Assign file ownership explicitly. Tell coders they are not alone in the codebase.
- reviewer: Code review and quality checks. Read-only.
- plan (alias: planner): Architecture design and task decomposition. Full context.
- awaiter: Long-running command monitor (tests, builds, deploys). Uses fast model, high iteration limit. Spawn in background and continue other work.

## Parameters
- role: Agent role (explore/coder/reviewer/plan/awaiter, aliases explorer/planner accepted)
- task: Concrete task description (be specific and self-contained)
- parallel: Set true + agents array for multiple agents with dependencies
- waitForCompletion: false to run in background (default true)
- forkContext: true to inherit parent conversation history
- isolation: "worktree" to give coder agent an isolated git branch (auto-cleanup if no changes)`;

const spawnInputSchema = {
  type: 'object' as const,
  properties: {
    role: {
      type: 'string',
      description: 'The role/ID of the agent (built-in or predefined)',
    },
    task: {
      type: 'string',
      description: 'The task for the agent to complete',
    },
    customPrompt: {
      type: 'string',
      description: 'Custom system prompt (overrides role default, enables dynamic mode)',
    },
    customTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Custom tool list for dynamic agents',
    },
    maxBudget: {
      type: 'number',
      description: 'Maximum budget in USD for this agent',
    },
    waitForCompletion: {
      type: 'boolean',
      description: 'Wait for agent to complete before returning',
    },
    maxIterations: {
      type: 'number',
      description: 'Maximum iterations for the agent (default: 20)',
    },
    forkContext: {
      type: 'boolean',
      description: 'When true, fork parent conversation history to the sub-agent. Use when the sub-agent needs full prior context (e.g. coder tasks that depend on earlier discussion).',
    },
    isolation: {
      type: 'string',
      enum: ['worktree'],
      description: 'Isolation mode. "worktree" creates a git worktree so the agent works on an isolated branch. Best for coder agents doing file edits in parallel. Auto-cleanup if no changes.',
    },
    parallel: {
      type: 'boolean',
      description: 'Enable parallel execution mode',
    },
    agents: {
      type: 'array',
      description: 'Array of agents for parallel execution',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          task: { type: 'string' },
          maxBudget: { type: 'number' },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of agents this one depends on',
          },
        },
        required: ['role', 'task'],
      },
    },
  },
  required: [] as string[],
};

export const spawnAgentSchema: ToolSchema = {
  name: 'spawn_agent',
  description: baseDescription,
  inputSchema: spawnInputSchema,
  category: 'multiagent',
  permissionLevel: 'execute',
};

export const agentSpawnSchema: ToolSchema = {
  name: 'AgentSpawn',
  description: `Advanced agent creation with full control over execution.

Use this tool when you need:
- Parallel execution (multiple agents at once)
- Background mode (fire and forget)
- Custom prompts or tools
- Budget control

For simple synchronous task delegation, use Task instead.

${baseDescription}`,
  inputSchema: spawnInputSchema,
  category: 'multiagent',
  permissionLevel: 'execute',
};
