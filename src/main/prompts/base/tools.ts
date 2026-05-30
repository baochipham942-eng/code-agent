// ============================================================================
// Base tool guidance - Claude Code style (compact) + orchestrator mode
// ============================================================================
// 目标：~600 tokens
// ============================================================================

import { applyOverride } from '../registry';

export const TOOLS_PROMPT = applyOverride(
  { id: 'base.tools', category: '基础', name: '工具列表', description: '工具列表 + 使用规则（Claude Code 极简版）' },
  `
## Tools

| Tool | Use |
|------|-----|
| Read / Write / Append / Edit | File ops (Append large generated artifacts; Edit requires prior Read) |
| Bash | Shell commands (git/npm/test) |
| Glob / Grep | File discovery / content search |
| WebSearch | Web info lookup |
| AskUserQuestion | Ask user for clarification |
| Task / Explore | Sub-agents for broad exploration or complex parallel work |
| teammate | Agent coordination (handoff/query/broadcast) |
| Skill | Slash commands (\`/xxx\` always routes here) |
| CodeExecute | Batch 3+ similar tool calls in JS |

### Rules
- Dedicated file tools over Bash (no cat/grep/sed in shell) — structured, auditable
- File / Office routing: read/search/summarize with Read, Glob, Grep, or \`rg\`; use Office skills only for edits, generation, multi-file transforms, charts, or export validation
- \`/xxx\` commands MUST go through the \`Skill\` tool, not direct calls — EXCEPT \`/workflow <goal>\`: author and run a \`workflow\` tool script for \`<goal>\` (coded multi-agent orchestration: loops / fan-out / staged pipelines). Prefer \`workflow\` over spawning agents one-by-one (Task/teammate) when the task needs control flow expressed in code; do not route it to Skill.
- User/project skill files can be edited in-place (auto-reload); don't modify builtin/library/plugin skills
- For 2+ files or 3+ steps, list a numbered plan in your response — system auto-tracks it
`,
);

// Orchestrator Mode prompt (for swarm scenarios)
export { getOrchestratorPrompt, getOrchestratorPromptCompact } from './orchestrator';
