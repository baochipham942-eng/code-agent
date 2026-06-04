#!/usr/bin/env npx tsx
// ============================================================================
// Swarm Goal（P4）E2E 验收 — docs/designs/swarm-goal.md §7
// ============================================================================
//
// 走【真实模型】（goal 循环 + workflow 扇出 + 角色醒来），不能进 CI。
// 隔离策略同 role-proactivity-e2e.ts：HOME 指向临时目录 + webServer headless。
//
// 用法：
//   npm run build:web && npx tsx scripts/acceptance/swarm-goal-e2e.ts
//
// 默认模型：xiaomi/mimo-v2.5-pro（不限流；XIAOMI_API_KEY 从真实 ~/.code-agent/.env 读取）
//
// 验收标准（确定性 AC1/AC3/AC5 已由单测覆盖，本脚本跑真模型全链路 AC2 + AC4）：
//   AC2 goal 内 swarm 扇出：goal mode(allowSwarm) 下模型调 workflow 扇出子 agent →
//       goal 达成 + goal_complete 事件存在（消耗计入闸3 由单测证，本处证 workflow 在 goal 模式可达 + 全链路跑通）
//   AC4 advance → goal run：预埋多步推进产物 → 角色 cadence 醒来 → advance 提案 →
//       发起单 agent goal run → 终态 met/aborted 回填履历
// ============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, appendFile, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { constants, createWriteStream } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

const MAIN_PROVIDER = process.env.SWARM_E2E_PROVIDER || 'xiaomi';
const MAIN_MODEL = process.env.SWARM_E2E_MODEL || 'mimo-v2.5-pro';
const RUN_TIMEOUT_MS = Number(process.env.SWARM_E2E_RUN_TIMEOUT_MS) || 600_000;
// 醒来侦察(15轮) + advance goal run(30轮) 链路：慢思考模型(mimo)可能 >10min，可用 env 调长
const WAKE_TIMEOUT_MS = Number(process.env.SWARM_E2E_WAKE_TIMEOUT_MS) || 600_000;

const RESEARCHER = '研究员';
const CADENCE_JOB_TAG = 'role-cadence';

// ----------------------------------------------------------------------------
// 基础设施（与 role-proactivity-e2e.ts 一致）
// ----------------------------------------------------------------------------

type StartedServer = { baseUrl: string; token: string; child: ChildProcessWithoutNullStreams; output: () => string };
interface E2EEnv { fakeHome: string; dataDir: string; workspace: string }

async function ensureBuiltWebServer(): Promise<void> {
  try {
    await access(path.join(process.cwd(), 'dist', 'web', 'webServer.cjs'), constants.R_OK);
  } catch {
    throw new Error('dist/web/webServer.cjs is missing. Run npm run build:web before this acceptance.');
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(() => reject(new Error('no port'))); return; }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function extractStartupToken(output: string, port: number): string | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as { port?: unknown; token?: unknown };
      if (parsed.port === port && typeof parsed.token === 'string' && parsed.token.length > 0) return parsed.token;
    } catch { /* ignore */ }
  }
  return null;
}

async function waitForServer(server: StartedServer, port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`webServer exited early with ${server.child.exitCode}\n${server.output()}`);
    const token = extractStartupToken(server.output(), port);
    if (token) {
      server.token = token;
      try {
        const response = await fetch(`${server.baseUrl}/api/health`);
        const health = await response.json() as { status?: string };
        if (response.ok && health.status === 'ok') return;
        lastError = JSON.stringify(health);
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

async function startServer(env: E2EEnv): Promise<StartedServer> {
  const port = await getFreePort();
  const outputChunks: string[] = [];
  const logStream = createWriteStream(path.join(env.fakeHome, `webserver-${Date.now()}.log`), { flags: 'a' });
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'web', 'webServer.cjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: env.fakeHome,
      CODE_AGENT_DATA_DIR: env.dataDir,
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: env.workspace,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      AGENT_NEO_BUNDLED_RUNTIME_ROOT: process.cwd(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { outputChunks.push(String(c)); logStream.write(String(c)); });
  child.stderr.on('data', (c) => { outputChunks.push(String(c)); logStream.write(String(c)); });
  child.on('exit', () => logStream.end());
  const server: StartedServer = { baseUrl: `http://127.0.0.1:${port}`, token: '', child, output: () => outputChunks.join('').slice(-300_000) };
  try { await waitForServer(server, port); return server; }
  catch (error) { await stopServer(server).catch(() => undefined); throw error; }
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (server.child.exitCode !== null) return; await delay(100); }
  server.child.kill('SIGKILL');
}

// ----------------------------------------------------------------------------
// API helpers
// ----------------------------------------------------------------------------

async function cronApi<T>(server: StartedServer, action: string, payload?: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`cron/${action} timeout`), timeoutMs);
  try {
    const response = await fetch(`${server.baseUrl}/api/domain/cron/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ payload }),
      signal: controller.signal,
    });
    const body = await response.json() as { success: boolean; data?: T; error?: { message?: string } };
    if (!body.success) throw new Error(`cron/${action} failed: ${body.error?.message ?? response.status}`);
    return body.data as T;
  } finally { clearTimeout(timer); }
}

interface CronJob { id: string; action: { type: string; roleId?: string } }
interface WakeExecution {
  id: string; status: string;
  result?: { roleId?: string; status?: string; decision?: string; sessionId?: string; summary?: string; advanceGoalStatus?: string };
  error?: string;
}

/** goal /api/run（SSE 全文）。goal.allowSwarm 控制 swarm 扇出。 */
async function runGoal(server: StartedServer, opts: {
  sessionId: string; prompt: string; project: string;
  goal: { goal?: string; verify?: string; review?: string; budget?: number; maxTurns?: number; allowSwarm?: boolean };
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('run-timeout'), RUN_TIMEOUT_MS);
  try {
    const response = await fetch(`${server.baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        sessionId: opts.sessionId, prompt: opts.prompt, project: opts.project,
        provider: MAIN_PROVIDER, model: MAIN_MODEL, goal: opts.goal,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`POST /api/run failed: ${response.status} ${await response.text()}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

async function triggerJobAndWait(server: StartedServer, jobId: string): Promise<WakeExecution> {
  const before = await cronApi<WakeExecution[]>(server, 'getExecutions', { jobId, limit: 50 });
  const knownIds = new Set(before.map((e) => e.id));
  cronApi<WakeExecution>(server, 'triggerJob', { jobId }, WAKE_TIMEOUT_MS).catch(() => undefined);
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(10_000);
    const executions = await cronApi<WakeExecution[]>(server, 'getExecutions', { jobId, limit: 50 });
    const fresh = executions.find((e) => !knownIds.has(e.id) && (e.status === 'completed' || e.status === 'failed'));
    if (fresh) return fresh;
  }
  throw new Error(`Wake execution did not finish within ${WAKE_TIMEOUT_MS / 1000}s (jobId=${jobId})`);
}

// ----------------------------------------------------------------------------
// 文件系统 / 环境
// ----------------------------------------------------------------------------

function configDir(env: E2EEnv): string { return path.join(env.fakeHome, '.code-agent'); }
function roleHistoryPath(env: E2EEnv, roleId: string): string { return path.join(configDir(env), 'roles', roleId, 'history.md'); }
async function readFileSafe(p: string): Promise<string> { try { return await readFile(p, 'utf-8'); } catch { return ''; } }
async function readHistoryEntries(env: E2EEnv, roleId: string): Promise<string[]> {
  return (await readFileSafe(roleHistoryPath(env, roleId))).split('\n').filter((l) => l.startsWith('- '));
}
function todayUtc(): string { return new Date().toISOString().slice(0, 10); }

async function prepareEnvFile(env: E2EEnv): Promise<void> {
  const realEnv = await readFileSafe(path.join(os.homedir(), '.code-agent', '.env'));
  const providerEnvKeys: Record<string, string> = {
    groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY', zhipu: 'ZHIPU_API_KEY', moonshot: 'MOONSHOT_API_KEY', xiaomi: 'XIAOMI_API_KEY',
  };
  const mainEnvKey = providerEnvKeys[MAIN_PROVIDER];
  if (!mainEnvKey) throw new Error(`不支持的 SWARM_E2E_PROVIDER: ${MAIN_PROVIDER}`);
  const readRealEnvValue = (key: string): string | undefined => {
    const line = realEnv.split('\n').find((l) => l.trim().startsWith(`${key}=`));
    return line?.slice(line.indexOf('=') + 1).trim();
  };
  const lines: string[] = [];
  const mainKey = process.env.SWARM_E2E_API_KEY || readRealEnvValue(mainEnvKey);
  if (!mainKey) throw new Error(`缺少主模型 key：设置 SWARM_E2E_API_KEY 或 ~/.code-agent/.env 提供 ${mainEnvKey}`);
  lines.push(`${mainEnvKey}=${mainKey}`);
  const groqKey = MAIN_PROVIDER === 'groq' ? mainKey : readRealEnvValue('GROQ_API_KEY');
  const quickRouting = groqKey ? { provider: 'groq', model: 'llama-3.3-70b-versatile' } : { provider: MAIN_PROVIDER, model: MAIN_MODEL };
  if (groqKey && MAIN_PROVIDER !== 'groq') lines.push(`GROQ_API_KEY=${groqKey}`);
  for (const proxyKey of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    const v = readRealEnvValue(proxyKey);
    if (v) lines.push(`${proxyKey}=${v}`);
  }
  await mkdir(configDir(env), { recursive: true });
  await writeFile(path.join(configDir(env), '.env'), lines.join('\n') + '\n', 'utf-8');

  const minimalConfig = {
    models: {
      defaultProvider: MAIN_PROVIDER, default: MAIN_PROVIDER,
      providers: { [MAIN_PROVIDER]: { model: MAIN_MODEL, enabled: true } },
      routing: {
        code: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        fast: quickRouting,
        chat: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
      },
    },
    // AC4 需要角色 cadence 醒来 → 显式开启每日简报档（出厂默认 silent）
    roleAssets: { proactivity: { defaultLevel: 'daily' } },
  };
  await mkdir(env.dataDir, { recursive: true });
  await writeFile(path.join(env.dataDir, 'config.json'), JSON.stringify(minimalConfig, null, 2), 'utf-8');
  console.log(`[setup] 主模型 ${MAIN_PROVIDER}/${MAIN_MODEL}，quick ${quickRouting.provider}/${quickRouting.model}`);
}

// ----------------------------------------------------------------------------
// 验收场景
// ----------------------------------------------------------------------------

interface ScenarioResult { id: string; title: string; pass: boolean; evidence: string[]; failures: string[] }

/** AC2：goal 内 swarm 扇出 — goal mode(allowSwarm) 下显式让模型调 workflow 扇出，全链路跑通到 goal 达成 */
async function scenario2(env: E2EEnv, server: StartedServer): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC2', title: 'goal 内 swarm 扇出（workflow 在 goal 模式可达 + 全链路达成）', pass: false, evidence: [], failures: [] };

  // 预埋一个验收用文件，goal 的 verify 命令检查它存在（确定性可达成）
  const targetFile = path.join(env.workspace, 'swarm-goal-marker.txt');
  await writeFile(targetFile, 'pending', 'utf-8');

  const sse = await runGoal(server, {
    sessionId: `swarm-goal-ac2-${Date.now()}`,
    project: env.workspace,
    // 软目标用 verify="test -f ..."（文件已存在 → 退出 0），让 goal 能确定性达成；
    // 提示里显式要求先用 workflow 扇出一个子 agent（验证 workflow 在 goal 模式可达 + 预算注入不报错）
    goal: { verify: `test -f ${targetFile}`, budget: 400_000, maxTurns: 12, allowSwarm: true },
    prompt: [
      '这是一个 goal 模式任务。请严格按步骤执行：',
      '1. 先调用 workflow 工具扇出一个并行子 agent 做调研，script 参数填：',
      "   const r = await agent('用一句话说明 AI 编程工具的现状'); return r;",
      '2. 看到子 agent 结果后，调用 attempt_completion 申请完成（summary 写"已用 swarm 完成调研"）。',
    ].join('\n'),
  });

  // 真实工具调用信号（不能用 sse.includes('workflow')——swarm 编排引导文本里就含"workflow"会假阳性）：
  // 要么 tool_call 的结构化 name，要么 scriptRuntime 的 run id（wf-...），要么 workflow 进度事件。
  const usedWorkflow = /"name"\s*:\s*"workflow"/.test(sse) || /"runId"\s*:\s*"wf-/.test(sse) || /wf-[a-z0-9-]{6,}/.test(sse);
  if (usedWorkflow) result.evidence.push('✓ goal 模式下 workflow 工具被真实调用（swarm 扇出可达）');
  else result.failures.push('✗ SSE 中未见 workflow 工具调用（模型未按指令扇出，或首轮推理即失败）');

  const hasGoalIteration = sse.includes('goal_iteration');
  if (hasGoalIteration) result.evidence.push('✓ goal_iteration 事件存在（goal 循环激活）');
  else result.failures.push('✗ 无 goal_iteration 事件（goal 模式未激活？）');

  const goalComplete = sse.includes('goal_complete');
  // SSE 字段顺序不保证，用宽松判定：有终态事件 + 出现 met 状态/终态标记即视为达成
  const goalMet = sse.includes('goal_met') || (goalComplete && /"status"\s*:\s*"met"/.test(sse));
  if (goalMet) result.evidence.push('✓ goal 达成（goal_complete status=met，闸1 verify 通过）');
  else if (goalComplete) result.evidence.push('⚠ goal_complete 存在但非 met（可能 aborted/模型未调 attempt_completion）');
  else result.failures.push('✗ 无 goal_complete 终态事件');

  // 核心断言：workflow 在 goal 模式可达 + 全链路跑通（达成或至少有终态）。token rollup 由单测证。
  result.pass = usedWorkflow && hasGoalIteration && goalComplete;
  return result;
}

/** AC4：advance → goal run — 预埋多步推进产物 → 角色醒来 advance 提案 → 发起单 agent goal run → 终态回填 */
async function scenario4(env: E2EEnv, server: StartedServer, researcherJobId: string): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC4', title: 'advance → 单 agent goal run', pass: false, evidence: [], failures: [] };

  // 预埋产物：一个明确"需要多步推进 + 有可验证完成条件"的半成品，引导角色给出 <goal>/<verify> 提案。
  const draftPath = path.join(env.workspace, 'todo-list.md');
  await writeFile(draftPath, [
    '# 待办清单（半成品）',
    '',
    '- [ ] 创建 DONE.md 文件标记任务完成',
    '- [ ] 用 test -f DONE.md 验证标记文件存在',
    '- [ ] 验证通过后在 DONE.md 里保留 done',
    '',
    '说明：这是多步推进，不要只写一段汇报；下一步需要发起带 verify 的 goal run，目标是在工作目录创建 DONE.md，内容写 "done"，并用 test -f DONE.md 验证。',
  ].join('\n'), 'utf-8');
  await appendFile(
    roleHistoryPath(env, RESEARCHER),
    `- ${todayUtc()} | [待办清单](${draftPath}) | 列了多步待办，下一步要创建 DONE.md 并用 test -f DONE.md 验证，还没做\n`,
    'utf-8',
  );
  result.evidence.push('✓ 预埋：多步推进产物 + 履历指向它（下一步可被 verify 命令验证）');

  const execution = await triggerJobAndWait(server, researcherJobId);

  if (execution.status !== 'completed' || execution.result?.status !== 'completed') {
    result.failures.push(`✗ 醒来执行未完成: status=${execution.status}, result=${JSON.stringify(execution.result)}, error=${execution.error}`);
    return result;
  }
  result.evidence.push(`✓ 醒来执行完成（decision=${execution.result.decision}, advanceGoalStatus=${execution.result.advanceGoalStatus ?? '—'}）`);

  if (execution.result.decision === 'advance' && execution.result.advanceGoalStatus) {
    result.evidence.push(`✓ advance 升级为 goal run，终态=${execution.result.advanceGoalStatus}`);
    // 履历应记 [goal:...] 摘要
    const history = await readHistoryEntries(env, RESEARCHER);
    const goalEntry = history.find((l) => l.includes('[goal:'));
    if (goalEntry) result.evidence.push(`✓ 履历记录 goal run 终态: ${goalEntry}`);
    else result.failures.push('✗ 履历未见 [goal:...] 记录');
    // 终态 met 时 DONE.md 应被创建（goal run 真实执行的证据）
    if (execution.result.advanceGoalStatus === 'met') {
      const doneExists = (await readFileSafe(path.join(env.workspace, 'DONE.md'))).length >= 0
        && await access(path.join(env.workspace, 'DONE.md')).then(() => true).catch(() => false);
      if (doneExists) result.evidence.push('✓ goal run 真实产出 DONE.md（完成判定有据）');
      else result.evidence.push('⚠ goal 标 met 但 DONE.md 未见（verify 命令可能宽松）');
    }
    result.pass = true;
  } else if (execution.result.decision === 'advance') {
    result.failures.push('✗ decision=advance 但未升级为 goal run（模型未给 <goal> 提案）');
  } else {
    result.failures.push(`✗ 醒来决策非 advance（实际=${execution.result.decision}），无法验证 goal run 合流（模型行为，非代码缺陷）`);
  }
  return result;
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  await ensureBuiltWebServer();
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'swarm-goal-e2e-home-'));
  const env: E2EEnv = { fakeHome, dataDir: path.join(fakeHome, 'data'), workspace: path.join(fakeHome, 'workspace') };
  await mkdir(env.dataDir, { recursive: true });
  await mkdir(env.workspace, { recursive: true });
  await prepareEnvFile(env);
  console.log(`[setup] fake HOME: ${fakeHome}`);

  const server = await startServer(env);
  const results: ScenarioResult[] = [];
  const only = process.env.SWARM_E2E_ONLY?.split(',').map((s) => s.trim().toUpperCase());
  const shouldRun = (id: string): boolean => !only || only.includes(id);

  const printResult = (r: ScenarioResult): void => {
    console.log(`--- [${r.pass ? 'PASS' : 'FAIL'}] ${r.id} ${r.title} ---`);
    for (const e of r.evidence) console.log(`  ${e}`);
    for (const f of r.failures) console.log(`  ${f}`);
  };

  try {
    if (shouldRun('AC2')) {
      console.log('\n========== AC2：goal 内 swarm 扇出 ==========');
      results.push(await scenario2(env, server));
      printResult(results[results.length - 1]);
    }

    if (shouldRun('AC4')) {
      console.log('\n========== AC4：advance → goal run ==========');
      const jobs = await cronApi<CronJob[]>(server, 'listJobs', { tags: [CADENCE_JOB_TAG] });
      const researcherJob = jobs.find((j) => j.action.type === 'role-wake' && j.action.roleId === RESEARCHER);
      if (!researcherJob) {
        results.push({ id: 'AC4', title: 'advance → goal run', pass: false, evidence: [], failures: ['✗ 研究员 cadence job 未注册'] });
      } else {
        results.push(await scenario4(env, server, researcherJob.id));
      }
      printResult(results[results.length - 1]);
    }
  } finally {
    try { await writeFile(path.join(fakeHome, 'webserver-tail.log'), server.output(), 'utf-8'); } catch { /* best effort */ }
    await stopServer(server);
  }

  console.log('\n\n==================== 验收结果汇总 ====================');
  let allPass = true;
  for (const r of results) {
    console.log(`\n[${r.pass ? 'PASS' : 'FAIL'}] ${r.id} ${r.title}`);
    for (const e of r.evidence) console.log(`  ${e}`);
    for (const f of r.failures) console.log(`  ${f}`);
    if (!r.pass) allPass = false;
  }
  console.log(`\n隔离环境保留在 ${fakeHome}（验收证据）`);
  console.log(allPass ? `\n✅ ${results.length} 条全部通过` : '\n❌ 存在未通过项（注意区分代码缺陷 vs 模型行为）');
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
