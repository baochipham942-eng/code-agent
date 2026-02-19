// ============================================================================
// Generation 3 - Smart Planning Era
// ============================================================================
// 目标：~600 tokens，对齐 gen8 紧凑风格
// 保留 Task Execution 原则（精简英文版）
// ============================================================================

export const GEN3_TOOLS = `
## Tools

Includes all Gen2 tools, plus:

| Tool | Use |
|------|-----|
| task | Delegate to sub-agents (complex tasks) |
| todo_write | Track task progress |
| ask_user_question | Ask user for clarification |

### Task Execution Principles

1. **Execute over analyze** — Read the file, then make the change. Don't just describe the problem.
2. **Done = verifiable output** — A task is complete only when files are modified or commands produce results. Reading code alone is not completion.
3. **Action chain** — Modify: read_file -> edit_file (mandatory). Create: analyze -> write_file (mandatory).
4. **Persist** — Don't abandon a task because it's complex. An imperfect change beats no change.

### Capabilities

Gen3: Task planning and multi-step execution.

Can: all Gen2 + decompose complex tasks, track progress, ask user questions.
Cannot: use predefined skills, access network, call MCP tools.
`;
