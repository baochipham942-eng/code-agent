/**
 * SWE-bench 单 case 端到端 runner（最小闭环：可执行回归 + LLM judge 二审）
 *
 * 用法：
 *   npx tsx eval/swe-bench/run-one-case.ts                              # 默认 django__django-10880
 *   npx tsx eval/swe-bench/run-one-case.ts --instance <instance_id>     # 指定 case
 *   npx tsx eval/swe-bench/run-one-case.ts --model mimo-v2.5            # 指定模型
 *
 * 流程：
 *   1. 重置 sandbox/django 到 base_commit
 *   2. 喂 problem_statement 给小米 MiMo
 *   3. agent 用 list_dir / read_file / grep_search / edit_file 修代码
 *   4. 调 finish 或达到 MAX_ROUNDS 终止
 *   5. git diff 收集 patch + diff 形状验证
 *   6. 应用 SWE-bench test_patch，跑 FAIL_TO_PASS 对应 Django 测试
 *   7. LLM judge 二审 patch 语义
 *   8. 报告落到 eval/swe-bench/runs/<date>-<instance_id>/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

import { XiaomiProvider } from '../../src/main/model/providers/xiaomiProvider';
import type { ModelMessage, ModelResponse } from '../../src/main/model/types';
import type { JSONSchema, ToolCall, ToolDefinition } from '../../src/shared/contract';
import { judgePatchEquivalence } from './judges/patchEquivalence';
import {
  applyAgentDiff,
  buildDiffShapeValidation,
  decideRunOutcome,
  diffShapePassed,
  resetSandboxToBase,
  runExecutableValidation,
  runExecutableValidationDocker,
} from './validation';
import { persistSweBenchRun } from './persistence';

// ─── 常量 ────────────────────────────────────────────────────────────
const SANDBOX_DJANGO = path.join(REPO_ROOT, 'eval/swe-bench/sandbox/django');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/swe-bench/runs');
const VERIFIED_JSONL = path.join(REPO_ROOT, 'eval-datasets/swe-bench/verified.jsonl');
const MAX_ROUNDS = 15;

// ─── 工具定义（agent 可调用） ──────────────────────────────────────────
const TOOLS: ToolDefinition[] = [
  {
    name: 'list_dir',
    description: '列出目录内容（相对 repo 根）。每行一个条目，前缀 D=目录 F=文件。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对 repo 根的路径，如 django/db/models' } },
      required: ['path'],
    } as JSONSchema,
    requiresPermission: false,
    permissionLevel: 'read',
  },
  {
    name: 'read_file',
    description: '读文件内容，返回带行号。每次最多读 200 行；offset 是 1-indexed 起始行。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: '起始行（1-indexed），默认 1' },
        limit: { type: 'number', description: '最多读多少行，默认 200' },
      },
      required: ['path'],
    } as JSONSchema,
    requiresPermission: false,
    permissionLevel: 'read',
  },
  {
    name: 'grep_search',
    description: '在 repo 里 grep 正则。只搜 .py 文件，最多返回 50 行匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索子目录，默认整个 repo' },
      },
      required: ['pattern'],
    } as JSONSchema,
    requiresPermission: false,
    permissionLevel: 'read',
  },
  {
    name: 'edit_file',
    description: '在文件中把 old_string 替换为 new_string。old_string 必须在文件中唯一出现。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: '要替换的原字符串（必须唯一）' },
        new_string: { type: 'string', description: '新字符串' },
      },
      required: ['path', 'old_string', 'new_string'],
    } as JSONSchema,
    requiresPermission: true,
    permissionLevel: 'write',
  },
  {
    name: 'finish',
    description: '完成修复时调用，附上修改摘要。',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    } as JSONSchema,
    requiresPermission: false,
    permissionLevel: 'read',
  },
];

// ─── 工具执行 ─────────────────────────────────────────────────────────
function exec_list_dir(args: { path: string }): string {
  const fullPath = path.join(SANDBOX_DJANGO, args.path);
  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    return entries.map((e) => `${e.isDirectory() ? 'D' : 'F'} ${e.name}`).join('\n') || '(empty)';
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

function exec_read_file(args: { path: string; offset?: number; limit?: number }): string {
  const fullPath = path.join(SANDBOX_DJANGO, args.path);
  try {
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    const offset = args.offset ?? 1;
    const limit = Math.min(args.limit ?? 200, 500);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

function exec_grep_search(args: { pattern: string; path?: string }): string {
  const subPath = args.path || '.';
  try {
    const out = execSync(
      `grep -rnE ${JSON.stringify(args.pattern)} ${JSON.stringify(subPath)} --include="*.py" 2>/dev/null | head -50`,
      { cwd: SANDBOX_DJANGO, encoding: 'utf8' },
    );
    return out || '(no matches)';
  } catch {
    return '(no matches)';
  }
}

function exec_edit_file(args: { path: string; old_string: string; new_string: string }): string {
  const fullPath = path.join(SANDBOX_DJANGO, args.path);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = content.split(args.old_string).length - 1;
    if (occurrences === 0) return `ERROR: old_string 不存在于 ${args.path}`;
    if (occurrences > 1) return `ERROR: old_string 在 ${args.path} 中出现 ${occurrences} 次，必须唯一`;
    fs.writeFileSync(fullPath, content.replace(args.old_string, args.new_string));
    return `OK: 在 ${args.path} 替换 1 处`;
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

function dispatchTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'list_dir':
      return exec_list_dir(args as { path: string });
    case 'read_file':
      return exec_read_file(args as { path: string; offset?: number; limit?: number });
    case 'grep_search':
      return exec_grep_search(args as { pattern: string; path?: string });
    case 'edit_file':
      return exec_edit_file(args as { path: string; old_string: string; new_string: string });
    case 'finish':
      return `FINISHED: ${(args as { summary: string }).summary}`;
    default:
      return `ERROR: 未知工具 ${name}`;
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const getArg = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const instanceId = getArg('--instance', 'django__django-10880');
  const model = getArg('--model', 'mimo-v2.5-pro');
  const runTag = getArg('--run-tag', '');
  // 默认 docker 模式（业界标准）；--mode python 切回本地 Python（兼容老路径）
  const execMode: 'docker' | 'python' = getArg('--mode', 'docker') === 'python' ? 'python' : 'docker';

  // 读 case
  const lines = fs.readFileSync(VERIFIED_JSONL, 'utf8').split('\n').filter(Boolean);
  type CaseData = {
    instance_id: string;
    repo: string;
    base_commit: string;
    problem_statement: string;
    patch: string;
    test_patch: string;
    FAIL_TO_PASS: string;
  };
  const caseData = lines.map((l) => JSON.parse(l) as CaseData).find((c) => c.instance_id === instanceId);
  if (!caseData) throw new Error(`Instance ${instanceId} not found in verified.jsonl`);

  console.log(`[setup] case=${instanceId} repo=${caseData.repo} base=${caseData.base_commit.slice(0, 12)}`);

  // 重置 + 切到这个 case 的 base_commit
  console.log(`[setup] 清理 sandbox + 切到 base_commit...`);
  resetSandboxToBase(SANDBOX_DJANGO, caseData.base_commit);
  console.log(`[setup] problem_statement (${caseData.problem_statement.length} chars):`);
  console.log(`        ${caseData.problem_statement.replace(/\n/g, '\n        ').slice(0, 300)}...`);

  // ── 构造 prompt ─────────────────────────────────────────
  const systemMsg = `你是一个软件工程师，正在 Django 仓库里修一个 bug。

工作目录：Django 项目，已 checkout 到 base_commit ${caseData.base_commit}。

任务规则：
- 用 list_dir / read_file / grep_search 定位问题
- 用 edit_file 直接修改源文件（不要生成 patch 文件）
- 修改要最小化，只改必须改的，不要顺手重构无关代码
- 不要修改 tests/ 下的测试文件（评测会自动加测试）
- 完成后调用 finish 工具，给出修改摘要

【关键 — 不要陷入死循环】：
- 已 edit_file 完成修改后，后续 grep/read 找不到额外验证信息时立刻调 finish，不要反复 grep
- 自我验证最多 1-2 轮即可
- 不确定的值（MIME type / IANA 标准 / 协议字符串）宁可在 finish summary 写"该值不确定，建议人工 review"，**不要瞎编一个看似专业的值**

【关键 — 探索黑洞预算】：
- 探索（grep/read/list_dir）连续超过 5 轮还**没有调 edit_file** 时，意味着你定位不到修复点
- 这时不要继续硬探索，立刻调 finish，summary 里写明：「探索 N 轮未能定位修复点。调研了 X / Y / Z（列出关键 grep pattern 和读过的文件）。可能需要改的位置是 [最佳猜测]，但不确定。建议人工接手。」
- 有放弃的勇气是合格工程师的标志，比硬撑 15 轮零产出更专业
- 注意：这条**只针对零 edit 的情况**。如果你已经 edit 过了在做验证，按"不要陷入死循环"规则即可

注意：edit_file 要求 old_string 在文件中唯一出现。如果不唯一，先 read_file 看上下文再加更多 context 让它唯一。`;

  const userMsg = `Issue:\n\n${caseData.problem_statement}\n\n请定位并修复这个 bug。`;

  const messages: ModelMessage[] = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg },
  ];

  // ── agent 循环 ──────────────────────────────────────────
  const provider = new XiaomiProvider();
  const config = {
    provider: 'xiaomi' as const,
    model,
    apiKey: process.env.XIAOMI_API_KEY!,
    maxTokens: 8192,
  };

  const trace: Array<Record<string, unknown>> = [];
  let finished = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastRound = 0;

  for (let round = 1; round <= MAX_ROUNDS && !finished; round++) {
    lastRound = round;
    console.log(`\n[round ${round}] inferring...`);
    const t0 = Date.now();
    let resp: ModelResponse;
    try {
      resp = await provider.inference(messages, TOOLS, config);
    } catch (e) {
      console.error(`[round ${round}] inference error:`, (e as Error).message);
      trace.push({ round, error: (e as Error).message });
      break;
    }
    const elapsed = Date.now() - t0;

    if (resp.usage) {
      totalInputTokens += resp.usage.inputTokens;
      totalOutputTokens += resp.usage.outputTokens;
    }

    const toolCalls = resp.toolCalls || [];
    const textPreview = (resp.content || '').slice(0, 200).replace(/\n/g, ' ');
    console.log(`[round ${round}] (${elapsed}ms) text="${textPreview}" tools=${toolCalls.length}`);

    // 把 assistant 消息加进 history
    messages.push({
      role: 'assistant',
      content: resp.content || '',
      toolCalls: toolCalls.map((tc: ToolCall) => ({
        id: tc.id || `call_${round}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
      })),
    });

    if (toolCalls.length === 0) {
      console.log(`[round ${round}] 没有 tool call，结束`);
      trace.push({ round, type: 'no_tools', text: resp.content });
      break;
    }

    // 执行 tool calls，把 tool 消息加进 history
    for (const tc of toolCalls) {
      const args = (typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments) as Record<string, unknown>;
      const result = dispatchTool(tc.name, args);
      const argStr = JSON.stringify(args);
      console.log(`  → ${tc.name}(${argStr.slice(0, 100)}${argStr.length > 100 ? '...' : ''})`);
      console.log(`    ⇒ ${result.split('\n')[0].slice(0, 150)}${result.length > 150 ? '...' : ''}`);
      trace.push({ round, tool: tc.name, args, result: result.slice(0, 1000) });

      messages.push({
        role: 'tool',
        content: result,
        toolCallId: tc.id || `call_${round}_${Math.random().toString(36).slice(2, 8)}`,
      });

      if (tc.name === 'finish') {
        finished = true;
      }
    }
  }

  // ── 收集 git diff + diff 形状验证 ────────────────────────────────
  const diff = execSync('git diff', { cwd: SANDBOX_DJANGO, encoding: 'utf8' });
  const diff_shape_validation = buildDiffShapeValidation(diff, caseData.patch);
  const diff_shape_passed = diffShapePassed(diff_shape_validation);

  // ── 可执行验证：默认 docker 模式（业界标准），fallback 本地 Python ──
  console.log(`\n[validation:${execMode}] 应用 test_patch 并跑 FAIL_TO_PASS 测试...`);
  const dateStrForRun = new Date().toISOString().slice(0, 10);
  const runIdForPatches = `${dateStrForRun}-${instanceId}${runTag ? `-${runTag}` : ''}`;
  const executable_validation = execMode === 'docker'
    ? runExecutableValidationDocker({
        instanceId,
        agentDiff: diff,
        testPatch: caseData.test_patch,
        failToPass: caseData.FAIL_TO_PASS,
        patchesDir: path.join(RUNS_DIR, runIdForPatches, '_docker-patches'),
      })
    : runExecutableValidation({
        sandboxRoot: SANDBOX_DJANGO,
        testPatch: caseData.test_patch,
        failToPass: caseData.FAIL_TO_PASS,
      });
  console.log(
    `[validation] status=${executable_validation.status} reason=${executable_validation.reason} labels=${executable_validation.test_labels.join(', ') || 'N/A'}`,
  );

  // 调 LLM-as-Judge 评语义等价（只有 not_empty 时才调，empty diff 没必要）
  let judge: Awaited<ReturnType<typeof judgePatchEquivalence>> | null = null;
  if (diff_shape_validation.not_empty) {
    console.log(`\n[judge] 调 DeepSeek 评 patch 语义等价度...`);
    const tJudge = Date.now();
    try {
      judge = await judgePatchEquivalence({
        problem_statement: caseData.problem_statement,
        agent_diff: diff,
        standard_patch: caseData.patch,
      });
      console.log(`[judge] (${Date.now() - tJudge}ms) semantic_match=${judge.semantic_match} matches_intent=${judge.matches_intent} matches_impl=${judge.matches_implementation}`);
      if (judge.key_differences.length > 0) {
        console.log(`[judge] key_differences:`);
        for (const d of judge.key_differences) console.log(`  - ${d}`);
      }
    } catch (e) {
      console.warn(`[judge] 失败: ${(e as Error).message}`);
    }
  }

  // 综合结果：finish + diff shape + 可执行验证 + judge 二审都过，才算 pass。
  const outcome = decideRunOutcome({
    finished,
    diff_shape_passed,
    executable_validation,
    judge,
  });
  const passed = outcome.passed;

  // ── 落盘报告 ────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const runId = `${dateStr}-${instanceId}${runTag ? `-${runTag}` : ''}`;
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'agent.diff'), diff);
  fs.writeFileSync(path.join(runDir, 'standard.patch'), caseData.patch);
  fs.writeFileSync(path.join(runDir, 'trace.json'), JSON.stringify(trace, null, 2));
  fs.writeFileSync(
    path.join(runDir, 'result.json'),
    JSON.stringify(
      {
        instance_id: instanceId,
        repo: caseData.repo,
        model,
        rounds_used: lastRound,
        finished,
        passed,
        status: outcome.status,
        failure_reasons: outcome.reasons,
        diff_shape_passed,
        diff_shape_validation,
        executable_validation,
        judge,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
      },
      null,
      2,
    ),
  );

  try {
    const { initDatabase } = await import('../../src/main/services/core/databaseService');
    const db = await initDatabase();
    const experimentId = persistSweBenchRun(db, runDir);
    db.close();
    console.log(`[eval-center] 已写入 experiment DB: ${experimentId}`);
  } catch (e) {
    console.warn(`[eval-center] 写入 experiment DB 失败: ${(e as Error).message}`);
  }

  // 可执行验证会把 SWE-bench test_patch 应用进 sandbox。报告写完后恢复到
  // "base_commit + agent diff" 状态，方便继续人工看 agent 实际改动。
  try {
    resetSandboxToBase(SANDBOX_DJANGO, caseData.base_commit);
    if (diff.trim()) {
      const restore = applyAgentDiff(SANDBOX_DJANGO, diff);
      if (!restore.ok) console.warn(`[cleanup] 恢复 agent diff 失败: ${restore.error}`);
    }
  } catch (e) {
    console.warn(`[cleanup] 恢复 sandbox 失败: ${(e as Error).message}`);
  }

  // ── 控制台总结 ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(
    `Result: ${passed ? '✅ PASSED' : '❌ FAILED'} (status=${outcome.status}, diff_shape=${diff_shape_passed}, executable=${executable_validation.status}, judge=${judge?.semantic_match ?? 'N/A'})`,
  );
  if (outcome.reasons.length > 0) console.log(`  failure_reasons: ${outcome.reasons.join(', ')}`);
  console.log(`  finished:        ${finished}`);
  console.log(`  rounds_used:     ${lastRound}/${MAX_ROUNDS}`);
  console.log(`  diff_shape_validation:`);
  for (const [k, v] of Object.entries(diff_shape_validation)) {
    const icon = v === true ? '✓' : v === false ? '✗' : ' ';
    console.log(`    ${icon} ${k}: ${v}`);
  }
  console.log(`  executable_validation:`);
  console.log(`    status: ${executable_validation.status}`);
  console.log(`    reason: ${executable_validation.reason}`);
  console.log(`    command: ${executable_validation.command?.join(' ') ?? 'N/A'}`);
  console.log(`    exit_code: ${executable_validation.exit_code ?? 'N/A'}`);
  if (judge) {
    console.log(`  judge (语义):`);
    console.log(`    semantic_match: ${judge.semantic_match}/100`);
    console.log(`    matches_intent: ${judge.matches_intent}`);
    console.log(`    matches_implementation: ${judge.matches_implementation}`);
    if (judge.key_differences.length > 0) {
      console.log(`    key_differences:`);
      for (const d of judge.key_differences) console.log(`      - ${d}`);
    }
    console.log(`    reasoning: ${judge.reasoning}`);
  }
  console.log(`  tokens: in=${totalInputTokens}, out=${totalOutputTokens}`);
  console.log(`\nAgent diff:`);
  console.log(diff || '  (empty — agent 没改任何文件)');
  console.log(`\nStandard patch (作对比):`);
  console.log(caseData.patch);
  console.log(`\n报告: ${runDir}/`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
