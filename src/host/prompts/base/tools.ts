// ============================================================================
// Base tool guidance - Claude Code style (compact) + orchestrator mode
// ============================================================================
// 目标：~600 tokens
// ============================================================================

import { applyOverride } from '../registry';

export const TOOLS_PROMPT = applyOverride(
  { id: 'base.tools', category: '基础', name: '工具路由', description: '延迟工具与特殊路由规则' },
  `
## Tools

The tool schemas in the current turn are the authoritative capability reference. Advanced parallel, background, or scripted multi-agent tools may be deferred; use them when loaded and available.

### Rules
- File / Office routing: read/search/summarize with Read, Glob, Grep, or \`rg\`; use Office skills only for edits, generation, multi-file transforms, charts, or export validation
- Capability ladder: connectors/native tools first (mail, calendar, reminders, MCP, files, shell); \`browser_action\` for web pages; screen control (\`mcp__cua-driver__*\`, \`computer_use\`) only when nothing above works. Before a task's first screen action, say ONE sentence in the user's language naming the app and why no connector/browser route works; if a connector is unavailable, say so and continue under normal per-app approval
- \`/xxx\` commands MUST go through the \`Skill\` tool, not direct calls — EXCEPT \`/workflow <goal>\`: author and run a \`workflow\` tool script for \`<goal>\` (coded multi-agent orchestration: loops / fan-out / staged pipelines). Prefer \`workflow\` over spawning agents one-by-one when the task needs control flow expressed in code; do not route it to Skill.
- User/project skill files can be edited in-place (auto-reload); don't modify builtin/library/plugin skills
- Skills are product capabilities, not decoration. For research, implementation closure, reviewer-facing delivery, files, data, slides, or design work, use the matching skill before improvising a long custom workflow.
- For 2+ files or 3+ steps, list a numbered plan in your response — system auto-tracks it
`,
);
