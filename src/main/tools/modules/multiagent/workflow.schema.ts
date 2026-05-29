// Schema-only file — dynamic-workflow 命令式脚本运行时入口（P1 命令层接线）
import type { ToolSchema } from '../../../protocol/tools';

// 工具描述本身就是「dynamic-workflow 原语文档」：模型读完后当场写一段 JS 编排脚本，
// 经 script 参数交给 scriptRuntime.startRun 在受限 worker 沙箱后台执行。
const description = `Author and run a JS orchestration script that fans out work across many sub-agents deterministically.

Use this when a task benefits from structured multi-agent control flow you express in code — loops, conditionals, fan-out/fan-in, staged pipelines — rather than spawning agents one by one. The middle results stay inside the script (they do NOT pollute your main context); only the script's \`return\` value comes back to you.

## How it works
You write the script body as a string in the \`script\` parameter. It runs in a background worker thread with these primitives already in scope (use \`await\`, and \`return\` the final result):

- **agent(prompt, opts?)** → spawn a sub-agent.
  - With \`opts.schema\` (a JSON Schema object): the sub-agent is forced to emit one structured result in a single turn; agent() returns the validated object. Use this for stable values your control flow branches on (counts, verdicts, extracted fields).
  - Without schema: the sub-agent runs a full tool-using agent loop and agent() returns its final text.
  - opts: \`{ schema?, model?: {provider, model}, label?, phase?, agentType? }\`. \`model\` overrides the model for this one call (cheap model to fan out, strong model to judge).
- **parallel(thunks)** → run \`Array<() => Promise<any>>\` concurrently; BARRIER, awaits all. A thunk that throws resolves to \`null\` — drop them with \`.filter((x) => x !== null)\`.
- **pipeline(items, ...stages)** → run each item through all stages independently, NO barrier (item A can be in stage 3 while B is still in stage 1). Each stage callback gets \`(prevResult, originalItem, index)\`. A stage that throws drops that item to \`null\`.
- **phase(title)** → start a new progress phase; subsequent agent() calls group under it.
- **log(message)** → emit a progress line.
- **args** → the \`goal\` string passed alongside the script.
- **budget** → token budget (output tokens). \`budget.total\` (number | null), \`budget.spent()\`, \`budget.remaining()\`. When a budgetTokens param is set it is a HARD ceiling: once spent reaches it, further agent() calls throw. Use it to scale fan-out depth dynamically, e.g. \`while (budget.total && budget.remaining() > 50000) { ... }\`. With no budget, remaining() is Infinity.

Concurrent agent() calls are capped globally (provider-aware) and total agent() calls per run are bounded — runaway scripts are terminated.

## Constraints
- Plain JavaScript, not TypeScript (no type annotations / interfaces / generics).
- \`require\`, \`process\`, module globals, and the filesystem are not in scope — the script orchestrates sub-agents, it does not do IO directly. Do work through \`agent()\`, not by reaching for fs/network.
- Avoid \`Date.now()\` / \`Math.random()\` for control flow — vary work by index instead. (They keep the run deterministic and replayable; non-determinism can desync resumable replay.)
- DEFAULT to \`pipeline()\`; only use a \`parallel()\` barrier when a stage genuinely needs ALL prior-stage results at once (dedup/merge/early-exit).

## Example
\`\`\`js
phase('Decompose');
const plan = await agent(
  'Break this research topic into 3 focused sub-questions: ' + args,
  { schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' } } }, required: ['questions'] } }
);
phase('Investigate');
const findings = await pipeline(
  plan.questions,
  (q) => agent('Answer concisely with evidence: ' + q,
    { schema: { type: 'object', properties: { finding: { type: 'string' }, confidence: { type: 'number' } }, required: ['finding','confidence'] } })
);
phase('Synthesize');
const report = await agent('Synthesize a cited report from these findings: ' + JSON.stringify(findings),
  { schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] } });
return report;
\`\`\`

## Parameters
- script (required): the JS orchestration script body (a string).
- goal: the task goal; exposed to the script as \`args\`.
- budgetTokens: optional output-token budget (hard ceiling); exposed as \`budget.total\`.`;

const workflowInputSchema = {
  type: 'object' as const,
  properties: {
    script: {
      type: 'string',
      description: 'The JS orchestration script body. Uses agent()/parallel()/pipeline()/phase()/log()/args in scope; await async work and return the final result.',
    },
    goal: {
      type: 'string',
      description: 'The task goal, exposed to the script as `args`.',
    },
    budgetTokens: {
      type: 'number',
      description: 'Optional output-token budget (hard ceiling). Exposed to the script as `budget.total`; once spent reaches it, agent() throws. Omit for no limit.',
    },
  },
  required: ['script'] as string[],
};

export const workflowSchema: ToolSchema = {
  name: 'workflow',
  description,
  inputSchema: workflowInputSchema,
  category: 'multiagent',
  permissionLevel: 'execute',
};
