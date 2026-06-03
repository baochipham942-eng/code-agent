#!/usr/bin/env npx tsx
// ============================================================================
// 角色主动性 E2E 验收（docs/designs/role-proactivity.md §9 的 5 条标准）
// ============================================================================
//
// 走【真实模型】（醒来实例 + 写回判断），不能进 CI。
// 隔离策略与 role-assets-e2e.ts 相同：HOME 指向临时目录。
//
// 用法：
//   npm run build:web && npx tsx scripts/acceptance/role-proactivity-e2e.ts
//
// 默认模型：xiaomi/mimo-v2.5-pro（不限流；XIAOMI_API_KEY 从真实 ~/.code-agent/.env 读取）
//
// 5 条验收标准：
//   AC1 启动同步注册：webServer 启动后每个持久化角色有一个 [Cadence] cron job（确定性，零模型成本）
//   AC2 cadence 醒来闭环：预埋履历产物 → triggerJob → 醒来完成 + 决策标记 + 履历新增 + 会话落地
//   AC3 沉默路径：空履历角色醒来 → 决策应为 silence → 会话归档 + 履历"巡检无需行动"
//   AC4 预算护栏：预埋当天 4 条醒来履历 → triggerJob → skipped（确定性，零模型成本）
//   AC5 event 触发：跑长任务（spawn 研究员，≥5 迭代）→ run 结束后研究员自动醒来（履历出现 event 条目）
// ============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, appendFile, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { constants, createWriteStream } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

// ----------------------------------------------------------------------------
// 配置
// ----------------------------------------------------------------------------

const MAIN_PROVIDER = process.env.ROLE_E2E_PROVIDER || 'xiaomi';
const MAIN_MODEL = process.env.ROLE_E2E_MODEL || 'mimo-v2.5-pro';
/** 单次醒来上限（15 轮迭代的模型 run），triggerJob 是同步等待的 */
const WAKE_TIMEOUT_MS = 600_000;
/** /api/run 长任务上限 */
const RUN_TIMEOUT_MS = 480_000;
/** event 触发是 fire-and-forget，run 结束后轮询履历的窗口 */
const EVENT_WAKE_POLL_MS = 600_000;

const RESEARCHER = '研究员';
const ANALYST = '数据分析师';
/** 与 ROLE_PROACTIVITY 常量保持一致（E2E 是黑盒，断言用字面值核对行为） */
const WAKE_TITLE_PREFIX = '主动巡检';
const CADENCE_JOB_TAG = 'role-cadence';
const MAX_WAKES_PER_DAY = 4;

// ----------------------------------------------------------------------------
// 基础设施（与 role-assets-e2e.ts 相同）
// ----------------------------------------------------------------------------

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

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
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')));
        return;
      }
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
      if (parsed.port === port && typeof parsed.token === 'string' && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch {
      // ignore non-startup JSON logs
    }
  }
  return null;
}

async function waitForServer(server: StartedServer, port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`webServer exited early with ${server.child.exitCode}\n${server.output()}`);
    }
    const token = extractStartupToken(server.output(), port);
    if (token) {
      server.token = token;
      try {
        const response = await fetch(`${server.baseUrl}/api/health`);
        const health = await response.json() as { status?: string };
        if (response.ok && health.status === 'ok') return;
        lastError = JSON.stringify(health);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

interface E2EEnv {
  fakeHome: string;
  dataDir: string;
  workspace: string;
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
  child.stdout.on('data', (chunk) => { outputChunks.push(String(chunk)); logStream.write(String(chunk)); });
  child.stderr.on('data', (chunk) => { outputChunks.push(String(chunk)); logStream.write(String(chunk)); });
  child.on('exit', () => logStream.end());

  const server: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: '',
    child,
    output: () => outputChunks.join('').slice(-200_000),
  };

  try {
    await waitForServer(server, port);
    return server;
  } catch (error) {
    await stopServer(server).catch(() => undefined);
    throw error;
  }
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return;
    await delay(100);
  }
  server.child.kill('SIGKILL');
}

// ----------------------------------------------------------------------------
// API helpers
// ----------------------------------------------------------------------------

/** cron domain API（IPC_DOMAINS.CRON = 'domain:cron' → POST /api/domain/cron/<action>） */
async function cronApi<T>(server: StartedServer, action: string, payload?: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`cron/${action} timeout`), timeoutMs);
  try {
    const response = await fetch(`${server.baseUrl}/api/domain/cron/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ payload }),
      signal: controller.signal,
    });
    const body = await response.json() as { success: boolean; data?: T; error?: { message?: string } };
    if (!body.success) {
      throw new Error(`cron/${action} failed: ${body.error?.message ?? response.status}`);
    }
    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 触发一次醒来并等待完成。
 *
 * 不能用单个长连接等 triggerJob 响应——Node fetch（undici）默认 headersTimeout 300s，
 * 醒来（思考模型 + 最多 15 轮）经常超过 5 分钟，长连接会被 undici 掐断（E2E 实测踩坑）。
 * 改为：fire-and-forget 触发 + 轮询 getExecutions 直到出现终态执行记录。
 */
async function triggerJobAndWait(server: StartedServer, jobId: string): Promise<WakeExecution> {
  const before = await cronApi<WakeExecution[]>(server, 'getExecutions', { jobId, limit: 50 });
  const knownIds = new Set(before.map((e) => e.id));

  // fire-and-forget：响应可能因 headers timeout 失败，忽略（执行结果靠轮询拿）
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

interface SessionEntry {
  id: string;
  title: string;
  isArchived?: boolean;
  type?: string;
}

/** 会话列表（GET /api/sessions?includeArchived=... → { success, data: Session[] }） */
async function listSessions(server: StartedServer, includeArchived: boolean): Promise<SessionEntry[]> {
  const response = await fetch(`${server.baseUrl}/api/sessions?includeArchived=${includeArchived}`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  if (!response.ok) {
    throw new Error(`GET /api/sessions failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { success?: boolean; data?: SessionEntry[] } | SessionEntry[];
  return Array.isArray(body) ? body : (body.data ?? []);
}

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  action: { type: string; roleId?: string };
  schedule: { type: string; expression?: string };
  tags?: string[];
}

interface WakeExecution {
  id: string;
  status: string;
  result?: {
    roleId?: string;
    trigger?: string;
    status?: string;
    skipReason?: string;
    decision?: string;
    sessionId?: string;
    summary?: string;
  };
  error?: string;
}

/** 跑一次 /api/run（AC5 长任务用），返回 SSE 全文 */
async function runAgent(server: StartedServer, options: { prompt: string; project: string; sessionId: string }): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('run-timeout'), RUN_TIMEOUT_MS);
  try {
    const response = await fetch(`${server.baseUrl}/api/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({
        sessionId: options.sessionId,
        prompt: options.prompt,
        project: options.project,
        provider: MAIN_PROVIDER,
        model: MAIN_MODEL,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`POST /api/run failed: ${response.status} ${await response.text()}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// 文件系统 helpers
// ----------------------------------------------------------------------------

function configDir(env: E2EEnv): string {
  return path.join(env.fakeHome, '.code-agent');
}

function roleHistoryPath(env: E2EEnv, roleId: string): string {
  return path.join(configDir(env), 'roles', roleId, 'history.md');
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

async function readHistoryEntries(env: E2EEnv, roleId: string): Promise<string[]> {
  return (await readFileSafe(roleHistoryPath(env, roleId))).split('\n').filter((l) => l.startsWith('- '));
}

/** 与 wakeRole 同算法的"今天"（UTC 日期，保持一致才能正确命中预算护栏） */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// 环境准备（与 role-assets-e2e.ts 相同的双链路凭证逻辑）
// ----------------------------------------------------------------------------

async function prepareEnvFile(env: E2EEnv): Promise<void> {
  const realEnvPath = path.join(os.homedir(), '.code-agent', '.env');
  const realEnv = await readFileSafe(realEnvPath);

  const providerEnvKeys: Record<string, string> = {
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    zhipu: 'ZHIPU_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
    xiaomi: 'XIAOMI_API_KEY',
  };
  const mainEnvKey = providerEnvKeys[MAIN_PROVIDER];
  if (!mainEnvKey) {
    throw new Error(`不支持的 ROLE_E2E_PROVIDER: ${MAIN_PROVIDER}（可选: ${Object.keys(providerEnvKeys).join(', ')}）`);
  }

  const readRealEnvValue = (key: string): string | undefined => {
    const line = realEnv.split('\n').find((l) => l.trim().startsWith(`${key}=`));
    return line?.slice(line.indexOf('=') + 1).trim();
  };

  const lines: string[] = [];

  const mainKey = process.env.ROLE_E2E_API_KEY || readRealEnvValue(mainEnvKey);
  if (!mainKey) {
    throw new Error(`缺少主模型 key：请设置 ROLE_E2E_API_KEY 或在 ~/.code-agent/.env 提供 ${mainEnvKey}`);
  }
  lines.push(`${mainEnvKey}=${mainKey}`);

  // 写回判断 quick model：优先 groq（免费档，判断请求小），没有则回落主模型
  const groqKey = MAIN_PROVIDER === 'groq' ? mainKey : readRealEnvValue('GROQ_API_KEY');
  const quickRouting = groqKey
    ? { provider: 'groq', model: 'llama-3.3-70b-versatile' }
    : { provider: MAIN_PROVIDER, model: MAIN_MODEL };
  if (groqKey && MAIN_PROVIDER !== 'groq') {
    lines.push(`GROQ_API_KEY=${groqKey}`);
  }

  for (const proxyKey of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    const v = readRealEnvValue(proxyKey);
    if (v) lines.push(`${proxyKey}=${v}`);
  }

  await mkdir(configDir(env), { recursive: true });
  await writeFile(path.join(configDir(env), '.env'), lines.join('\n') + '\n', 'utf-8');

  const minimalConfig = {
    models: {
      defaultProvider: MAIN_PROVIDER,
      default: MAIN_PROVIDER,
      providers: {
        [MAIN_PROVIDER]: { model: MAIN_MODEL, enabled: true },
      },
      routing: {
        code: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        fast: quickRouting,
        chat: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
      },
    },
    // 角色主动性出厂默认 silent（opt-in）：E2E 通过 settings 显式开启每日简报档，
    // 否则 AC1 的 cadence job 注册和后续醒来场景都不会发生
    roleAssets: {
      proactivity: { defaultLevel: 'daily' },
    },
  };
  await mkdir(env.dataDir, { recursive: true });
  await writeFile(path.join(env.dataDir, 'config.json'), JSON.stringify(minimalConfig, null, 2), 'utf-8');
  console.log(`[setup] 主模型: ${MAIN_PROVIDER}/${MAIN_MODEL}，写回判断 quick model: ${quickRouting.provider}/${quickRouting.model}`);
}

// ----------------------------------------------------------------------------
// 验收场景
// ----------------------------------------------------------------------------

interface ScenarioResult {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
  failures: string[];
}

/** AC1：启动后每个持久化角色有一个 cadence cron job（确定性） */
async function scenario1(server: StartedServer): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC1', title: '启动同步注册 cadence cron job', pass: false, evidence: [], failures: [] };

  const jobs = await cronApi<CronJob[]>(server, 'listJobs', { tags: [CADENCE_JOB_TAG] });
  const byRole = new Map(jobs.filter((j) => j.action.type === 'role-wake').map((j) => [j.action.roleId, j]));

  for (const roleId of [RESEARCHER, ANALYST]) {
    const job = byRole.get(roleId);
    if (job && job.enabled) {
      result.evidence.push(`✓ ${roleId} 有 cadence job: "${job.name}"（cron: ${job.schedule.expression ?? '?'}, enabled）`);
    } else {
      result.failures.push(`✗ ${roleId} 没有注册 cadence cron job`);
    }
  }

  result.pass = result.failures.length === 0;
  return result;
}

/** AC2：cadence 醒来闭环 — 预埋履历产物 → 触发 → 完成 + 决策 + 履历 + 会话 */
async function scenario2(env: E2EEnv, server: StartedServer, researcherJobId: string): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC2', title: 'cadence 醒来闭环（履历产物巡检）', pass: false, evidence: [], failures: [] };

  // 预埋产物：workspace 里放一个半成品报告 + 履历指向它
  const reportPath = path.join(env.workspace, 'ai-coding-report.md');
  await writeFile(reportPath, [
    '# AI 编程工具行业调研报告（初稿）',
    '',
    '## 1. 市场规模',
    '2026 年 AI 编程工具市场规模约 120 亿美元。',
    '',
    '## 2. 竞品定价',
    'TODO: 这一节还没写完，需要补充 Cursor / Copilot / Claude Code 的定价对比。',
    '',
  ].join('\n'), 'utf-8');
  await appendFile(
    roleHistoryPath(env, RESEARCHER),
    `- ${todayUtc()} | [AI 编程工具行业调研报告](${reportPath}) | 完成了行业调研初稿，竞品定价部分还没写\n`,
    'utf-8',
  );
  result.evidence.push(`✓ 预埋：产物文件 ${reportPath} + 研究员履历 1 条`);

  const historyBefore = (await readHistoryEntries(env, RESEARCHER)).length;
  const sessionsBefore = (await listSessions(server, true)).length;

  // 触发醒来（fire-and-forget + 轮询执行记录）
  const execution = await triggerJobAndWait(server, researcherJobId);

  if (execution.status === 'completed' && execution.result?.status === 'completed') {
    result.evidence.push(`✓ 醒来执行完成（decision=${execution.result.decision}, session=${execution.result.sessionId}）`);
  } else {
    result.failures.push(`✗ 醒来执行未完成: status=${execution.status}, result=${JSON.stringify(execution.result)}, error=${execution.error}`);
    result.pass = false;
    return result;
  }

  const decision = execution.result.decision ?? '';
  if (['advance', 'report', 'suggest', 'silence'].includes(decision)) {
    result.evidence.push(`✓ 四选一决策标记有效: ${decision}`);
  } else {
    result.failures.push(`✗ 决策标记无效: "${decision}"`);
  }

  // 履历必须新增一条醒来记录（含沉默）
  const historyAfter = await readHistoryEntries(env, RESEARCHER);
  const wakeEntries = historyAfter.filter((l) => l.includes(WAKE_TITLE_PREFIX));
  if (historyAfter.length > historyBefore && wakeEntries.length >= 1) {
    result.evidence.push(`✓ 履历新增醒来记录: ${wakeEntries[wakeEntries.length - 1]}`);
  } else {
    result.failures.push(`✗ 履历没有新增醒来记录（before=${historyBefore}, after=${historyAfter.length}）`);
  }

  // 会话落地：非沉默 → 在默认列表；沉默 → 已归档（含归档的列表能看到）
  const allSessions = await listSessions(server, true);
  const wakeSession = allSessions.find((s) => s.id === execution.result?.sessionId);
  if (wakeSession) {
    result.evidence.push(`✓ 醒来会话已落地: "${wakeSession.title}"（archived=${!!wakeSession.isArchived}）`);
    if (allSessions.length > sessionsBefore) {
      result.evidence.push(`✓ 会话总数 ${sessionsBefore} → ${allSessions.length}`);
    }
    const visibleSessions = await listSessions(server, false);
    const inDefaultList = visibleSessions.some((s) => s.id === wakeSession.id);
    if (decision === 'silence' && inDefaultList) {
      result.failures.push('✗ 决策为沉默但会话仍出现在默认列表（应已归档）');
    } else if (decision !== 'silence' && !inDefaultList) {
      result.failures.push('✗ 决策非沉默但会话不在默认列表');
    } else {
      result.evidence.push(`✓ 会话可见性与决策一致（decision=${decision}, 默认列表可见=${inDefaultList}）`);
    }
  } else {
    result.failures.push(`✗ 醒来会话 ${execution.result?.sessionId} 不在会话列表中`);
  }

  result.pass = result.failures.length === 0;
  return result;
}

/** AC3：沉默路径 — 空履历角色醒来 → 空产物守卫确定性静默（零模型成本）+ 履历"巡检无需行动" */
async function scenario3(env: E2EEnv, server: StartedServer, analystJobId: string): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC3', title: '沉默路径（空履历 → 确定性 silence）', pass: false, evidence: [], failures: [] };

  const sessionsBefore = (await listSessions(server, true)).length;
  const execution = await triggerJobAndWait(server, analystJobId);

  if (execution.status !== 'completed' || execution.result?.status !== 'completed') {
    result.failures.push(`✗ 醒来执行未完成: ${JSON.stringify(execution.result)}, error=${execution.error}`);
    return result;
  }

  const decision = execution.result.decision ?? '';
  if (decision === 'silence') {
    result.evidence.push('✓ 空履历角色醒来 → 确定性 silence（空产物守卫，未烧模型 token）');
  } else {
    result.failures.push(`✗ 空履历角色未静默，决策为: ${decision}`);
  }

  // 履历记录（沉默也记）且措辞为"巡检无需行动"
  const history = await readHistoryEntries(env, ANALYST);
  const wakeEntry = history.find((l) => l.includes(WAKE_TITLE_PREFIX));
  if (wakeEntry?.includes('巡检无需行动')) {
    result.evidence.push(`✓ 履历有沉默记录: ${wakeEntry}`);
  } else {
    result.failures.push(`✗ 履历沉默记录缺失或措辞不对: ${wakeEntry ?? '（无）'}`);
  }

  // 静默不打扰：不应产生新会话（空产物守卫在创建会话前就返回了）
  const sessionsAfter = (await listSessions(server, true)).length;
  if (sessionsAfter === sessionsBefore) {
    result.evidence.push(`✓ 静默醒来没有产生新会话（${sessionsBefore} → ${sessionsAfter}）`);
  } else {
    result.failures.push(`✗ 静默醒来产生了多余会话（${sessionsBefore} → ${sessionsAfter}）`);
  }

  result.pass = result.failures.length === 0;
  return result;
}

/** AC4：预算护栏 — 当天醒来次数到上限 → skipped（确定性，零模型成本） */
async function scenario4(env: E2EEnv, server: StartedServer, analystJobId: string): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC4', title: `预算护栏（每天 ${MAX_WAKES_PER_DAY} 次上限）`, pass: false, evidence: [], failures: [] };

  // 把数据分析师今天的醒来记录补到上限（AC3 可能已产生 1 条）
  const existing = (await readHistoryEntries(env, ANALYST))
    .filter((l) => l.startsWith(`- ${todayUtc()} `) && l.includes(WAKE_TITLE_PREFIX)).length;
  const toSeed = Math.max(0, MAX_WAKES_PER_DAY - existing);
  for (let i = 0; i < toSeed; i++) {
    await appendFile(
      roleHistoryPath(env, ANALYST),
      `- ${todayUtc()} | ${WAKE_TITLE_PREFIX}(cadence) | [report] 预埋的醒来记录 ${i + 1}（E2E 预算护栏测试）\n`,
      'utf-8',
    );
  }
  result.evidence.push(`✓ 预埋：当天醒来记录补至 ${existing + toSeed} 条（上限 ${MAX_WAKES_PER_DAY}）`);

  // 再触发 → 必须被预算护栏拦截
  const execution = await triggerJobAndWait(server, analystJobId);

  if (execution.result?.status === 'skipped' && (execution.result.skipReason ?? '').includes('daily_budget_exceeded')) {
    result.evidence.push(`✓ 第 ${MAX_WAKES_PER_DAY + 1} 次醒来被预算护栏拦截: ${execution.result.skipReason}`);
    result.pass = true;
  } else {
    result.failures.push(`✗ 预算护栏未生效: ${JSON.stringify(execution.result)}`);
  }

  return result;
}

/** AC5：event 触发 — 长任务（spawn 研究员，≥5 迭代）跑完 → 研究员自动醒来 */
async function scenario5(env: E2EEnv, server: StartedServer): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC5', title: 'event 触发（长任务跑完 → 角色自动醒来）', pass: false, evidence: [], failures: [] };

  const eventEntriesBefore = (await readHistoryEntries(env, RESEARCHER))
    .filter((l) => l.includes(`${WAKE_TITLE_PREFIX}(event)`)).length;

  // 长任务：多步骤强制 ≥5 迭代（spawn 子代理 + 写文件 + 读文件 + 汇报）
  // 注意 subagent_type 必须精确写明（上一轮 E2E 实测：mimo 会把"委派给研究员"自作主张替换成
  // 内置 explore 类型 → 没有持久化角色参与 run → 不触发 event 醒来，测试失效）
  const sse = await runAgent(server, {
    sessionId: `proactivity-e2e-ac5-${Date.now()}`,
    project: env.workspace,
    prompt: [
      '请严格按以下步骤依次执行（每步都要真实调用工具，不要跳步）：',
      `1. 调用 Task 工具委派子代理，参数 subagent_type 必须精确填 '${RESEARCHER}'（就是这三个汉字，`,
      `   禁止替换成 explore/coder/general 等任何内置类型——'${RESEARCHER}' 是已注册的自定义角色），`,
      `   prompt 填 '用两句话总结 AI 编程工具的市场现状'`,
      `2. 把子代理的回复写入文件 ${path.join(env.workspace, 'market-summary.md')}（用 Write 工具）`,
      `3. 用 Read 工具读取 ${path.join(env.workspace, 'ai-coding-report.md')}，检查"竞品定价"一节是否完整`,
      `4. 把检查结论追加写入 ${path.join(env.workspace, 'market-summary.md')}（用 Edit 或 Write 工具）`,
      '5. 最后向我汇报：子代理说了什么 + 报告检查结论',
    ].join('\n'),
  });

  if (sse.includes('agent_complete')) {
    result.evidence.push('✓ 长任务 run 正常完成');
  } else {
    result.failures.push('✗ 长任务 run 未正常完成（SSE 无 agent_complete）');
    return result;
  }

  // event 醒来是 fire-and-forget，轮询研究员履历等 (event) 条目出现
  console.log(`  [AC5] run 已完成，轮询研究员履历等 event 醒来（最多 ${EVENT_WAKE_POLL_MS / 1000}s）...`);
  const deadline = Date.now() + EVENT_WAKE_POLL_MS;
  let eventEntries: string[] = [];
  while (Date.now() < deadline) {
    eventEntries = (await readHistoryEntries(env, RESEARCHER))
      .filter((l) => l.includes(`${WAKE_TITLE_PREFIX}(event)`));
    if (eventEntries.length > eventEntriesBefore) break;
    await delay(5_000);
  }

  if (eventEntries.length > eventEntriesBefore) {
    result.evidence.push(`✓ 研究员被 event 触发醒来: ${eventEntries[eventEntries.length - 1]}`);
    result.pass = true;
  } else {
    // 失败可能性：run 迭代数 < 5（长任务门槛）→ 检查 webServer 日志辅助判断
    const log = (await readFileSafe(path.join(env.fakeHome, 'webserver-tail.log'))) || '(无)';
    const hasEventLog = log.includes('triggering event wakes') || log.includes('Long task completed');
    result.failures.push(
      `✗ run 结束后研究员未被 event 触发醒来（可能 run 迭代数 < 5 门槛；日志含触发记录=${hasEventLog}）`,
    );
  }

  return result;
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  await ensureBuiltWebServer();

  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'proactivity-e2e-home-'));
  const dataDir = path.join(fakeHome, 'data');
  const workspace = path.join(fakeHome, 'workspace');
  const env: E2EEnv = { fakeHome, dataDir, workspace };

  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await prepareEnvFile(env);

  console.log(`[setup] fake HOME: ${fakeHome}`);

  const server = await startServer(env);
  const results: ScenarioResult[] = [];

  try {
    // 启动后检查：预设角色已安装（installBuiltinRoles 在 webServer 启动时执行）
    const rolesInstalled = await readHistoryEntries(env, RESEARCHER); // 目录不存在时返回 []
    const roleDirExists = (await readFileSafe(path.join(configDir(env), 'agents', `${RESEARCHER}.md`))).length > 0;
    console.log(`[setup] 预设角色检查: agents/${RESEARCHER}.md 存在=${roleDirExists}, 履历条目=${rolesInstalled.length}`);
    if (!roleDirExists) {
      throw new Error('预设角色未安装 — webServer installBuiltinRoles 接线有问题');
    }

    const printResult = (r: ScenarioResult): void => {
      console.log(`--- [${r.pass ? 'PASS' : 'FAIL'}] ${r.id} ${r.title} ---`);
      for (const e of r.evidence) console.log(`  ${e}`);
      for (const f of r.failures) console.log(`  ${f}`);
    };

    const only = process.env.ROLE_E2E_ONLY?.split(',').map((s) => s.trim().toUpperCase());
    const shouldRun = (id: string): boolean => !only || only.includes(id);

    // AC1（确定性）：启动同步注册，并拿到后续场景要用的 jobId
    console.log('\n========== AC1：启动同步注册 cadence cron job ==========');
    const ac1 = await scenario1(server);
    if (shouldRun('AC1')) {
      results.push(ac1);
      printResult(ac1);
    }
    const jobs = await cronApi<CronJob[]>(server, 'listJobs', { tags: [CADENCE_JOB_TAG] });
    const researcherJob = jobs.find((j) => j.action.type === 'role-wake' && j.action.roleId === RESEARCHER);
    const analystJob = jobs.find((j) => j.action.type === 'role-wake' && j.action.roleId === ANALYST);
    if (!researcherJob || !analystJob) {
      throw new Error('cadence job 未注册，后续场景无法进行');
    }

    if (shouldRun('AC2')) {
      console.log('\n========== AC2：cadence 醒来闭环 ==========');
      results.push(await scenario2(env, server, researcherJob.id));
      printResult(results[results.length - 1]);
    }

    if (shouldRun('AC3')) {
      console.log('\n========== AC3：沉默路径 ==========');
      results.push(await scenario3(env, server, analystJob.id));
      printResult(results[results.length - 1]);
    }

    if (shouldRun('AC4')) {
      console.log('\n========== AC4：预算护栏 ==========');
      results.push(await scenario4(env, server, analystJob.id));
      printResult(results[results.length - 1]);
    }

    if (shouldRun('AC5')) {
      console.log('\n========== AC5：event 触发（长任务跑完自动醒来）==========');
      results.push(await scenario5(env, server));
      printResult(results[results.length - 1]);
    }
  } finally {
    try {
      await writeFile(path.join(fakeHome, 'webserver-tail.log'), server.output(), 'utf-8');
    } catch { /* best effort */ }
    await stopServer(server);
  }

  // 汇总
  console.log('\n\n==================== 验收结果汇总 ====================');
  let allPass = true;
  for (const r of results) {
    console.log(`\n[${r.pass ? 'PASS' : 'FAIL'}] ${r.id} ${r.title}`);
    for (const e of r.evidence) console.log(`  ${e}`);
    for (const f of r.failures) console.log(`  ${f}`);
    if (!r.pass) allPass = false;
  }
  console.log(`\n隔离环境保留在 ${fakeHome}（验收证据，可手动检查后删除）`);
  console.log(allPass ? `\n✅ ${results.length} 条验收标准全部通过` : '\n❌ 存在未通过的验收标准');
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
