// Schema-only file — dynamic-workflow 命令式脚本运行时入口（P1 命令层接线）
import type { ToolSchema } from '../../../protocol/tools';
import { getProtocolToolSchemas } from '../../protocolToolRegistration';
import { renderToolsSdk, type SdkToolProjection } from '../../../agent/scriptRuntime/toolsSdk';

// 工具描述本身就是「dynamic-workflow 原语文档」：模型读完后当场写一段 JS 编排脚本，
// 经 script 参数交给 scriptRuntime.startRun 在受限 worker 沙箱后台执行。
const description = `Author and run a JS orchestration script that fans out work across many sub-agents deterministically.

Use this when a task benefits from structured multi-agent control flow you express in code — loops, conditionals, fan-out/fan-in, staged pipelines — rather than spawning agents one by one. The middle results stay inside the script (they do NOT pollute your main context); only the script's \`return\` value comes back to you.

## How it works
You write the script body as a string in the \`script\` parameter. It runs in a background worker thread with these primitives already in scope (use \`await\`, and \`return\` the final result):

- **agent(prompt, opts?)** → spawn a sub-agent.
  - With \`opts.schema\` (a JSON Schema object): the sub-agent is forced to emit one structured result in a single turn; agent() returns the validated object. Use this for stable values your control flow branches on (counts, verdicts, extracted fields).
  - Without schema: the sub-agent runs a full tool-using agent loop and agent() returns its final text.
  - opts: \`{ schema?, model?: {provider, model}, label?, phase?, agentType?, tools? }\`. \`model\` overrides the model for this one call (cheap model to fan out, strong model to judge). \`tools\` picks the sub-agent's tool profile (full-agent path only): \`'readonly'\` (default — web + Read/Glob/Grep), \`'edit'\` (+ Edit/Write), \`'full'\` (+ Bash). Grant write tools only when the agent must modify files; running multiple write-capable agents in parallel shares one working tree and risks clobbering — serialize writers or give them distinct subpaths.
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
- \`Date.now()\` / \`new Date()\` (no-arg) / \`Date()\` / \`Math.random()\` / \`performance.now()\` are REJECTED before the run starts — they break resumable replay (the cache key depends on deterministic script behavior). Vary work by index, and take any time/random seed via \`args\` instead.
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
    resumeFromRunId: {
      type: 'string',
      description: 'Optional: resume from ANY prior run (completed, failed, or cancelled). Re-runs the same script; agent() calls whose (prompt + opts + resolved model + goal/args context) are unchanged return their cached results instantly (no inference, no token cost), and only edited/new calls run live. Pass the runId returned in a prior run\'s meta. If the runId has no journal (typo / cleaned up), or the prior run goal/args context differs, the run proceeds fully live and logs a warning — it is not a hard error. The returned meta includes `cacheHits` so you can confirm resume took effect.',
    },
  },
  required: ['script'] as string[],
};

/**
 * PTC（Code Mode）开关。默认关——本仓既有形态（CODEX_SANDBOX_ENABLED /
 * CROSS_VERIFY_ENABLED 也是显式 env 才启用）。
 *
 * 这里是**接线用的临时档位**，不是产品级的呈现档：dsh 把档位放在 agent preset
 * （会话组合时定死、整个会话不变，为的是请求前缀稳定 → KV cache 有效），Neo 还没有
 * 那一层。产品形态见 ADR §六第 1 条，由完整 S3 落地。
 */
export function isPtcEnabled(): boolean {
  return process.env.CODE_AGENT_PTC_ENABLED === '1';
}

/**
 * PTC 投影的工具集合——**下发侧与执行侧的单一真源**。
 * 分成两处各写一份名单，就是本仓反复复发的那族漏洞（投影里有、执行里没有 =
 * 模型照着签名写了却 UNKNOWN_TOOL；反过来 = 没告诉模型却能调 = 扩权）。
 * workflow 自己排除在外（照抄 dsh 对 run_code 的处理），顺带断掉脚本递归起 run 的路。
 */
export function getPtcProjectedTools(): SdkToolProjection[] {
  return getProtocolToolSchemas()
    .filter((schema) => schema.name !== 'workflow' && schema.inputSchema && schema.outputSchema)
    .map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      outputSchema: schema.outputSchema,
    }));
}

/**
 * 开着 PTC 时，把工具目录的 TS SDK 投影附在工具描述后面——模型要写出
 * `await tools.Read({path})`，前提是它在写脚本前看过签名，而工具描述正是它
 * 召回这个工具时读到的东西。
 *
 * 失败不能打挂整张工具表：渲染抛错（某个工具的 outputSchema 与投影口径漂了）时
 * 回落到静态描述，但**必须留痕**——静默回落等于 PTC 悄悄失效且现场零线索。
 */
function buildDescription(): string {
  if (!isPtcEnabled()) return description;
  try {
    const projections = getPtcProjectedTools();
    // 扫到 0 个工具说明注册表还没填充（getProtocolToolSchemas 未初始化时静默返回 []）——
    // 那时生成的是一份「你一个工具都没有」的 SDK，比不生成更坏，所以按失败处理。
    if (projections.length === 0) {
      console.warn('[workflow] PTC 已开启但工具注册表为空，SDK 投影跳过（回落静态描述）');
      return description;
    }
    return `${description}\n\n${renderToolsSdk(projections)}`;
  } catch (error) {
    console.warn(
      `[workflow] PTC SDK 投影渲染失败，回落静态描述：${error instanceof Error ? error.message : String(error)}`,
    );
    return description;
  }
}

export const workflowSchema: ToolSchema = {
  name: 'workflow',
  description,
  dynamicDescription: buildDescription,
  outputSchema: { type: 'string' },
  inputSchema: workflowInputSchema,
  category: 'multiagent',
  permissionLevel: 'execute',
};
