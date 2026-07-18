#!/usr/bin/env npx tsx
// ============================================================================
// 持久化角色资产 E2E 验收（docs/designs/persistent-role-assets.md §8 的 4 条标准）
// ============================================================================
//
// 与 agent-team-smoke 不同，本脚本走【真实模型】（主 agent + 子代理 + 写回判断），
// 因此需要 ~/.code-agent/.env 里有 DEEPSEEK_API_KEY 和 ZHIPU_API_KEY，且不能进 CI。
//
// 隔离策略：HOME 指向临时目录 → 角色/记忆全部写入假 HOME，不污染真实 ~/.code-agent；
// 只把模型 API key 相关的 .env 行拷贝进假 HOME。
//
// 用法：
//   npm run build:web && npx tsx scripts/acceptance/role-assets-e2e.ts
//
// 4 条验收标准：
//   1. 用研究员做一次调研 → 角色记忆出现条目 → 重启应用 → 再用研究员 → 引用上次的记忆
//   2. 换数据分析师 → 看不到研究员的角色记忆，但看得到全局记忆（MemoryRead 默认 global）
//   3. 同一角色在两个 workspace 工作 → 项目记忆互相隔离
//   4. 角色面板能看到记忆和履历，删除记忆后实例不再引用
// ============================================================================

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { constants, createWriteStream, readFileSync } from 'fs';
import * as crypto from 'crypto';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

// ----------------------------------------------------------------------------
// 配置
// ----------------------------------------------------------------------------

// 主模型默认跟随 app 当前配置的默认 provider（~/.code-agent/settings.json 的 models.defaultProvider），
// 不再写死——这样 E2E 始终用爸设置里的默认（现在是 xiaomi/mimo），切谁跟谁，不用每次手挑 key。
// 仍可用 ROLE_E2E_PROVIDER / ROLE_E2E_MODEL / ROLE_E2E_API_KEY 显式覆盖。
// 注意：Groq 免费档单请求 12k tokens 上限 < agent loop 单请求 ~20k tokens，不能当主模型，
// 只够给写回判断（quick model）用。
// 各 provider 在 settings 没显式写 model 时的兜底默认（与 app 默认对齐）
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  xiaomi: 'mimo-v2.5-pro',
  zhipu: 'glm-5',
  deepseek: 'deepseek-chat',
  moonshot: 'kimi-k2.5',
  groq: 'llama-3.3-70b-versatile',
};

/** 读 app 配置的默认 provider/model（跟随 settings.json，读不到则回落 zhipu/glm-5）。 */
function readConfiguredDefault(): { provider: string; model: string } {
  try {
    const settingsPath = path.join(os.homedir(), '.code-agent', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const provider: string | undefined = settings?.models?.defaultProvider;
    if (provider) {
      const model =
        settings?.models?.providers?.[provider]?.model ||
        PROVIDER_DEFAULT_MODEL[provider] ||
        '';
      if (model) return { provider, model };
    }
  } catch {
    // settings 读不到/解析失败 → 回落
  }
  return { provider: 'zhipu', model: 'glm-5' };
}

const configuredDefault = readConfiguredDefault();
const MAIN_PROVIDER = process.env.ROLE_E2E_PROVIDER || configuredDefault.provider;
const MAIN_MODEL = process.env.ROLE_E2E_MODEL || configuredDefault.model;
const RUN_TIMEOUT_MS = 360_000; // 单次 agent run 上限（含 Groq 免费档限流重试的余量）
const WRITE_BACK_POLL_MS = 120_000; // 写回是异步的，最多等这么久（含限流重试余量）
/** 场景之间的间歇，给 Groq 免费档 TPM 限流留恢复窗口 */
const INTER_SCENARIO_COOLDOWN_MS = Number(process.env.ROLE_E2E_COOLDOWN_MS || 30_000);

const RESEARCHER = '研究员';
const ANALYST = '数据分析师';

// ----------------------------------------------------------------------------
// 基础设施（参考 agent-team-smoke.ts）
// ----------------------------------------------------------------------------

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
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
  workspaceA: string;
  workspaceB: string;
}

async function startServer(env: E2EEnv): Promise<StartedServer> {
  const port = await getFreePort();
  const outputChunks: string[] = [];
  // 服务端日志持续落盘（进程被外部 kill 时 finally 不执行，靠这个保住排障证据）
  const logStream = createWriteStream(path.join(env.fakeHome, `webserver-${Date.now()}.log`), { flags: 'a' });
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'web', 'webServer.cjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // 假 HOME：~/.code-agent → fakeHome/.code-agent，隔离真实环境
      HOME: env.fakeHome,
      CODE_AGENT_DATA_DIR: env.dataDir,
      // E2E=1 只跳过 auth/telemetry；不设 LOCAL_SUBAGENT/LOCAL_AGENT_MODEL → 真模型真子代理
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: env.workspaceA,
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

/** 模型端瞬时错误（中转限流/服务过载），值得重试 */
const TRANSIENT_RUN_ERRORS = ['服务繁忙', 'rate limit', 'Rate limit', '429', 'overloaded', 'try again'];
/** run 级重试次数（针对瞬时错误） */
const RUN_MAX_ATTEMPTS = 3;
/** 瞬时错误重试前的退避（给 0ki/Groq 限流窗口恢复） */
const RUN_RETRY_BACKOFF_MS = 75_000;

/** 跑一次 agent run（SSE 流读完即结束），返回完整 SSE 文本。瞬时模型错误自动重试。 */
async function runAgent(server: StartedServer, options: {
  prompt: string;
  project: string;
  sessionId: string;
}): Promise<string> {
  let lastSse = '';
  for (let attempt = 1; attempt <= RUN_MAX_ATTEMPTS; attempt++) {
    const sessionId = attempt === 1 ? options.sessionId : `${options.sessionId}-retry${attempt}`;
    const sse = await runAgentOnce(server, { ...options, sessionId });
    lastSse = sse;

    // run 级错误检测：第一轮 E2E 的教训——run 报错后仍会发 agent_complete，
    // 不检查错误的话所有场景都"静默完成"，failure 看起来像功能问题实际是模型挂了。
    const runErrors = [...sse.matchAll(/event: error\ndata: (\{[^\n]*\})/g)]
      .map((m) => {
        try { return (JSON.parse(m[1]) as { message?: string }).message ?? m[1]; } catch { return m[1]; }
      });
    if (runErrors.length === 0) return sse;

    const uniqueErrors = [...new Set(runErrors)];
    console.log(`  [run:${sessionId}] ⚠ run 报错: ${uniqueErrors.join(' | ')}`);

    const isTransient = uniqueErrors.some((e) => TRANSIENT_RUN_ERRORS.some((t) => e.includes(t)));
    if (!isTransient || attempt === RUN_MAX_ATTEMPTS) return sse;

    console.log(`  [run:${sessionId}] 瞬时错误，${RUN_RETRY_BACKOFF_MS / 1000}s 后重试（${attempt}/${RUN_MAX_ATTEMPTS}）`);
    await delay(RUN_RETRY_BACKOFF_MS);
  }
  return lastSse;
}

async function runAgentOnce(server: StartedServer, options: {
  prompt: string;
  project: string;
  sessionId: string;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('run-timeout'), RUN_TIMEOUT_MS);
  try {
    // 注意：agent router 挂载在 /api 下、路由是 /run（POST /api/run，不是 /api/agent/run）
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
      throw new Error(`agent/run failed: ${response.status} ${await response.text()}`);
    }
    // SSE 流在 run 结束时由服务端关闭，text() 等到流结束
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 角色面板 domain API */
async function rolesApi<T>(server: StartedServer, action: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${server.baseUrl}/api/domain/roles/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
    },
    body: JSON.stringify({ payload }),
  });
  const body = await response.json() as { success: boolean; data?: T; error?: { message?: string } };
  if (!body.success) {
    throw new Error(`roles/${action} failed: ${body.error?.message ?? response.status}`);
  }
  return body.data as T;
}

/** 从 SSE 文本里提取所有 assistant 内容（粗提取，用于断言关键词） */
function extractAssistantText(sse: string): string {
  // SSE 数据行里有大量 JSON（message 快照、delta 等），直接全文返回供关键词断言；
  // 同时做一次 unicode 反转义，便于匹配中文。
  let text = sse;
  try {
    text = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  } catch {
    // keep raw
  }
  return text;
}

// ----------------------------------------------------------------------------
// 文件系统断言 helpers（与 roleAssetPaths 同算法）
// ----------------------------------------------------------------------------

function configDir(env: E2EEnv): string {
  return path.join(env.fakeHome, '.code-agent');
}

function roleDir(env: E2EEnv, roleId: string): string {
  return path.join(configDir(env), 'roles', roleId);
}

function projectKey(workspacePath: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 16);
}

function projectMemoriesDir(env: E2EEnv, workspacePath: string): string {
  return path.join(configDir(env), 'projects', projectKey(workspacePath), 'memory', 'memories');
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/** 轮询等待角色记忆写回（异步 fire-and-forget，需要等待） */
async function waitForRoleMemories(env: E2EEnv, roleId: string, minCount: number): Promise<string[]> {
  const memoriesDir = path.join(roleDir(env, roleId), 'memories');
  const deadline = Date.now() + WRITE_BACK_POLL_MS;
  while (Date.now() < deadline) {
    const files = (await listDirSafe(memoriesDir)).filter((f) => f.endsWith('.md'));
    if (files.length >= minCount) return files;
    await delay(2_000);
  }
  return (await listDirSafe(memoriesDir)).filter((f) => f.endsWith('.md'));
}

async function waitForHistoryEntries(env: E2EEnv, roleId: string, minCount: number): Promise<string[]> {
  const historyPath = path.join(roleDir(env, roleId), 'history.md');
  const deadline = Date.now() + WRITE_BACK_POLL_MS;
  while (Date.now() < deadline) {
    const entries = (await readFileSafe(historyPath)).split('\n').filter((l) => l.startsWith('- '));
    if (entries.length >= minCount) return entries;
    await delay(2_000);
  }
  return (await readFileSafe(historyPath)).split('\n').filter((l) => l.startsWith('- '));
}

// ----------------------------------------------------------------------------
// 环境准备
// ----------------------------------------------------------------------------

/**
 * 准备模型凭证。两条独立的模型链路都要有活 key：
 *
 * 1. 主模型（agent loop + 子代理）：MAIN_PROVIDER/MAIN_MODEL。
 *    key 来源优先级：ROLE_E2E_API_KEY 环境变量 > 真实 ~/.code-agent/.env 中同名 env key。
 *    2026-06-03 实测推荐 zhipu/glm-5（ROLE_E2E_API_KEY 传 0ki 包年 key，零边际成本）。
 *
 * 2. 写回判断 quick model：解析顺序 routing.fast → routing.code → ZHIPU env 兜底，
 *    且 zhipu 在 quickModel 里强制走官方 bigmodel.cn 端点（0ki key 不可用）。
 *    因此 routing.fast 指到 groq（GROQ_API_KEY 从真实 .env 读，免费档；判断请求小，TPM 够）。
 *    没有 groq key 时回落到主模型 provider（zhipu 时写回会失败 → 只记履历）。
 */
async function prepareEnvFile(env: E2EEnv): Promise<void> {
  const realEnvPath = path.join(os.homedir(), '.code-agent', '.env');
  const realEnv = await readFileSafe(realEnvPath);

  // 主模型 provider 对应的 env key（agent route 的 providerEnvMap 同名映射）
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

  // 1) 主模型 key
  const mainKey = process.env.ROLE_E2E_API_KEY || readRealEnvValue(mainEnvKey);
  if (!mainKey) {
    throw new Error(`缺少主模型 key：请设置 ROLE_E2E_API_KEY 或在 ~/.code-agent/.env 提供 ${mainEnvKey}`);
  }
  lines.push(`${mainEnvKey}=${mainKey}`);

  // 1.5) xiaomi/mimo 需要 XIAOMI_API_URL（token-plan-sgp 海外端点；providers.ts 已强制直连，不要给它套代理）
  if (MAIN_PROVIDER === 'xiaomi') {
    const xiaomiUrl = readRealEnvValue('XIAOMI_API_URL');
    if (xiaomiUrl) lines.push(`XIAOMI_API_URL=${xiaomiUrl}`);
  }

  // 2) 写回判断 quick model 的 groq key（主模型不是 groq 时才需要单独的）
  const groqKey = MAIN_PROVIDER === 'groq' ? mainKey : readRealEnvValue('GROQ_API_KEY');
  const quickRouting = groqKey
    ? { provider: 'groq', model: 'llama-3.3-70b-versatile' }
    : { provider: MAIN_PROVIDER, model: MAIN_MODEL };
  if (groqKey && MAIN_PROVIDER !== 'groq') {
    lines.push(`GROQ_API_KEY=${groqKey}`);
  }

  // 3) 代理（海外端点用；国内端点不受影响）
  for (const proxyKey of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    const v = readRealEnvValue(proxyKey);
    if (v) lines.push(`${proxyKey}=${v}`);
  }

  await mkdir(configDir(env), { recursive: true });
  await writeFile(path.join(configDir(env), '.env'), lines.join('\n') + '\n', 'utf-8');

  // config.json 写进 data dir（configService 的 resolveStoreBaseDir = CODE_AGENT_DATA_DIR）
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
  };
  await mkdir(env.dataDir, { recursive: true });
  await writeFile(path.join(env.dataDir, 'config.json'), JSON.stringify(minimalConfig, null, 2), 'utf-8');
  console.log(`[setup] 写回判断 quick model: ${quickRouting.provider}/${quickRouting.model}`);
}

/** 预埋一条全局记忆（验收 2：换角色后仍看得到全局记忆） */
async function seedGlobalMemory(env: E2EEnv): Promise<void> {
  const memoryDir = path.join(configDir(env), 'memory');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(memoryDir, 'company-info.md'),
    `---\nname: 公司信息\ndescription: 公司年会等基础信息\ntype: reference\n---\n\n公司年会日期是 7 月 15 日，地点在上海。\n`,
    'utf-8',
  );
  await writeFile(
    path.join(memoryDir, 'INDEX.md'),
    `# Memory Index\n\n- [company-info.md](company-info.md) — 公司年会等基础信息\n`,
    'utf-8',
  );
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

function spawnPrompt(role: string, task: string): string {
  return [
    `请立即调用 spawn_agent 工具，把下面的任务完整委派给"${role}"角色，不要自己执行任务内容。`,
    `参数：role='${role}'，waitForCompletion=true，task='${task}'`,
    `子代理完成后，把它的回复原文转述给我。`,
  ].join('\n');
}

/** 验收 1：研究员记忆闭环 + 重启后引用 */
async function scenario1(env: E2EEnv, getServer: () => StartedServer, restartServer: () => Promise<void>): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC1', title: '研究员调研 → 记忆落盘 → 重启 → 引用记忆', pass: false, evidence: [], failures: [] };

  // Run 1：给研究员喂可记忆的知识。
  // 写回判断走 quick model（groq 免费档），可能因瞬时限流失败 → 记忆 0 条但履历有。
  // 这种情况重试一轮 run（隔了重试退避后 TPM 窗口已恢复）。
  const RUN1_MAX_ATTEMPTS = 2;
  let memories: string[] = [];
  let history: string[] = [];
  for (let attempt = 1; attempt <= RUN1_MAX_ATTEMPTS; attempt++) {
    const run1 = await runAgent(getServer(), {
      sessionId: `role-e2e-ac1-${Date.now()}`,
      project: env.workspaceA,
      prompt: spawnPrompt(
        RESEARCHER,
        '我们团队的调研规范有两条：第一，所有结论必须标注一手信源；第二，GMV 口径不含退款、统计周期是自然周。请确认你理解了这两条规范，并用一句话复述它们。',
      ),
    });
    if (!extractAssistantText(run1).includes('agent_complete')) {
      result.failures.push(`Run 1 (attempt ${attempt}) 未正常完成（SSE 中无 agent_complete）`);
    }

    // 等待异步写回：history 必须有（确定性），memories 依赖 quick model 判断
    history = await waitForHistoryEntries(env, RESEARCHER, attempt);
    memories = await waitForRoleMemories(env, RESEARCHER, 1);
    if (memories.length >= 1) break;

    if (attempt < RUN1_MAX_ATTEMPTS) {
      console.log(`  [AC1] 写回 0 条记忆（quick model 可能撞限流），重试 Run 1（${attempt}/${RUN1_MAX_ATTEMPTS}）`);
      await delay(60_000); // 给 quick model 限流窗口恢复
    }
  }

  if (history.length >= 1) {
    result.evidence.push(`✓ 履历已写入 ${history.length} 条: ${history[history.length - 1]}`);
  } else {
    result.failures.push('✗ 写回后履历（history.md）没有条目');
  }

  if (memories.length >= 1) {
    const firstMemory = await readFileSafe(path.join(roleDir(env, RESEARCHER), 'memories', memories[0]));
    result.evidence.push(`✓ 角色记忆已写入 ${memories.length} 条: ${memories.join(', ')}`);
    result.evidence.push(`  记忆内容摘要: ${firstMemory.slice(0, 200).replace(/\n/g, ' ')}`);
  } else {
    result.failures.push('✗ 写回后角色记忆（memories/）没有条目');
  }

  const memoryIndex = await readFileSafe(path.join(roleDir(env, RESEARCHER), 'MEMORY.md'));
  if (memories.length >= 1 && memoryIndex.includes(memories[0])) {
    result.evidence.push('✓ MEMORY.md 索引包含新记忆条目');
  }

  // 关掉应用重开
  await restartServer();
  result.evidence.push('✓ webServer 已重启（模拟关掉应用重开）');

  // Run 2：重启后研究员应引用上次的记忆
  const run2 = await runAgent(getServer(), {
    sessionId: `role-e2e-ac1b-${Date.now()}`,
    project: env.workspaceA,
    prompt: spawnPrompt(
      RESEARCHER,
      '根据你的角色记忆回答：我们团队的 GMV 口径是什么？调研规范是什么？如果你的角色记忆索引（role_assets 块）里有相关条目，先用 MemoryRead 工具（scope="role"）读取再回答；如果完全没有相关记忆，明确说"角色记忆中没有相关记录"。',
    ),
  });
  const run2Text = extractAssistantText(run2);
  const cites = run2Text.includes('不含退款') || run2Text.includes('一手信源') || run2Text.includes('自然周');
  if (cites) {
    result.evidence.push('✓ 重启后研究员引用了上次的记忆（回答包含"不含退款"/"一手信源"/"自然周"）');
  } else {
    result.failures.push('✗ 重启后研究员未引用上次的记忆');
  }

  result.pass = history.length >= 1 && memories.length >= 1 && cites;
  return result;
}

/** 验收 2：数据分析师看不到研究员的角色记忆，但看得到全局记忆 */
async function scenario2(env: E2EEnv, server: StartedServer): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC2', title: '换数据分析师 → 角色记忆隔离 + 全局记忆可见', pass: false, evidence: [], failures: [] };

  const run = await runAgent(server, {
    sessionId: `role-e2e-ac2-${Date.now()}`,
    project: env.workspaceA,
    prompt: spawnPrompt(
      ANALYST,
      '两个问题分别回答：1) 你的角色记忆索引（role_assets 块的"角色记忆索引"部分）里有哪些条目？逐条列出文件名，一条都没有就明确说"角色记忆为空"。2) 用 MemoryRead 工具（不带 scope 参数，filename="company-info.md"）读取全局记忆，告诉我公司年会日期是哪天。',
    ),
  });
  const text = extractAssistantText(run);

  // 断言 A：看不到研究员的角色记忆（研究员记忆关键词不出现在分析师的角色记忆列举中）
  // 文件系统层面双保险：数据分析师 roles 目录此时不应有研究员写入的记忆文件
  const analystMemories = await listDirSafe(path.join(roleDir(env, ANALYST), 'memories'));
  const researcherMemories = await listDirSafe(path.join(roleDir(env, RESEARCHER), 'memories'));
  const crossContaminated = analystMemories.some((f) => researcherMemories.includes(f));
  if (!crossContaminated) {
    result.evidence.push(`✓ 文件系统隔离：数据分析师记忆目录（${analystMemories.length} 条）与研究员（${researcherMemories.length} 条）无交叉`);
  } else {
    result.failures.push('✗ 数据分析师记忆目录混入了研究员的记忆文件');
  }

  // 断言 B：看得到全局记忆（回答里有年会日期）
  const seesGlobal = text.includes('7 月 15') || text.includes('7月15');
  if (seesGlobal) {
    result.evidence.push('✓ 数据分析师通过 MemoryRead（默认 global scope）读到了全局记忆（年会日期 7 月 15 日）');
  } else {
    result.failures.push('✗ 数据分析师没有读到全局记忆');
  }

  result.pass = !crossContaminated && seesGlobal;
  return result;
}

/** 验收 3：同一角色在两个 workspace → 项目记忆隔离 */
async function scenario3(env: E2EEnv, server: StartedServer): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC3', title: '同一角色双 workspace → 项目记忆隔离', pass: false, evidence: [], failures: [] };

  // Workspace A：研究员显式写一条项目记忆（确定性：显式工具调用）
  await runAgent(server, {
    sessionId: `role-e2e-ac3a-${Date.now()}`,
    project: env.workspaceA,
    prompt: spawnPrompt(
      RESEARCHER,
      '调用 MemoryWrite 工具记录一条项目记忆，参数：action="write"，scope="project"，filename="report-template.md"，name="周报模板"，description="本项目周报模板位置"，content="本项目的周报模板在 docs/templates/weekly.md，按部门分三个 sheet。" 写完后回复"已记录"。',
    ),
  });

  const wsAMemories = await listDirSafe(projectMemoriesDir(env, env.workspaceA));
  if (wsAMemories.includes('report-template.md')) {
    result.evidence.push(`✓ workspace A 项目记忆已写入: ${wsAMemories.join(', ')}`);
  } else {
    result.failures.push(`✗ workspace A 项目记忆未写入（目录内容: ${wsAMemories.join(', ') || '空'}）`);
  }

  // Workspace B：研究员的项目记忆索引应该是空的
  const runB = await runAgent(server, {
    sessionId: `role-e2e-ac3b-${Date.now()}`,
    project: env.workspaceB,
    prompt: spawnPrompt(
      RESEARCHER,
      '你的当前项目记忆索引（role_assets 块的"当前项目记忆索引"部分）里有哪些条目？逐条列出文件名。如果该部分不存在或为空，明确回答"项目记忆为空"。不要提及角色记忆，只看项目记忆。',
    ),
  });
  const textB = extractAssistantText(runB);

  const wsBMemories = await listDirSafe(projectMemoriesDir(env, env.workspaceB));
  const wsBClean = !wsBMemories.includes('report-template.md');
  // 正向断言：B 中的研究员应明确回答项目记忆为空。
  // 不能用"整个 SSE 不含 '周报模板'"做反向断言——角色履历（角色级、跨项目共享，设计行为）
  // 里有 run A 的履历条目，会随角色注入块出现在 SSE 上下文事件里，误伤断言。
  // 项目层隔离的硬证据是上面的文件系统检查。
  const saysEmpty = textB.includes('项目记忆为空') || /项目记忆[^"]{0,12}(为空|是空|没有|不存在)/.test(textB);

  if (wsBClean) {
    result.evidence.push(`✓ workspace B 项目记忆目录不含 A 的记忆（内容: ${wsBMemories.join(', ') || '空'}）`);
  } else {
    result.failures.push('✗ workspace B 项目记忆目录混入了 A 的记忆');
  }
  if (saysEmpty) {
    result.evidence.push('✓ workspace B 中研究员明确回答"项目记忆为空"（看不到 A 的项目记忆）');
  } else {
    result.failures.push('✗ workspace B 中研究员未确认项目记忆为空');
  }

  result.pass = wsAMemories.includes('report-template.md') && wsBClean && saysEmpty;
  return result;
}

/** 验收 4：角色面板看到记忆和履历 + 删除后实例不再引用 */
async function scenario4(env: E2EEnv, server: StartedServer): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: 'AC4', title: '角色面板（记忆+履历）→ 删除记忆 → 实例不再引用', pass: false, evidence: [], failures: [] };

  // 面板 list
  const list = await rolesApi<Array<{ roleId: string; memoryCount: number; lastWork: string | null }>>(server, 'list');
  const researcher = list.find((r) => r.roleId === RESEARCHER);
  if (researcher && researcher.memoryCount >= 1 && researcher.lastWork) {
    result.evidence.push(`✓ 面板列表：研究员 ${researcher.memoryCount} 条记忆，最近工作: ${researcher.lastWork.slice(0, 80)}`);
  } else {
    result.failures.push(`✗ 面板列表数据不完整: ${JSON.stringify(researcher)}`);
  }

  // 面板 detail
  const detail = await rolesApi<{ memories: Array<{ filename: string }>; history: string[] }>(
    server, 'detail', { roleId: RESEARCHER },
  );
  if (detail.memories.length >= 1 && detail.history.length >= 1) {
    result.evidence.push(`✓ 面板详情：${detail.memories.length} 条记忆 + ${detail.history.length} 条履历`);
  } else {
    result.failures.push(`✗ 面板详情数据不完整: memories=${detail.memories.length}, history=${detail.history.length}`);
  }

  // 删除全部角色记忆
  for (const memory of detail.memories) {
    await rolesApi(server, 'deleteMemory', { roleId: RESEARCHER, filename: memory.filename });
  }
  const afterDelete = await rolesApi<{ memories: Array<{ filename: string }> }>(server, 'detail', { roleId: RESEARCHER });
  if (afterDelete.memories.length === 0) {
    result.evidence.push('✓ 面板删除生效：角色记忆清零');
  } else {
    result.failures.push(`✗ 删除后仍有 ${afterDelete.memories.length} 条记忆`);
  }

  // 文件系统确认：MEMORY.md 索引也清掉了
  const indexAfter = await readFileSafe(path.join(roleDir(env, RESEARCHER), 'MEMORY.md'));
  const indexClean = !indexAfter.includes('](memories/');
  if (indexClean) {
    result.evidence.push('✓ MEMORY.md 索引中的记忆条目已清除');
  } else {
    result.failures.push('✗ MEMORY.md 索引仍残留记忆条目');
  }

  // 删除后实例不再引用
  const run = await runAgent(server, {
    sessionId: `role-e2e-ac4-${Date.now()}`,
    project: env.workspaceA,
    prompt: spawnPrompt(
      RESEARCHER,
      '严格根据你的角色记忆索引（role_assets 块）回答：我们团队的 GMV 口径是什么？规则：只能引用角色记忆索引里实际存在的条目；如果索引为空或没有相关条目，必须回答"角色记忆中没有相关记录"，禁止凭对话上下文或常识编造。',
    ),
  });
  const text = extractAssistantText(run);
  const noLongerCites = text.includes('没有相关记录') || text.includes('角色记忆为空') ||
    (!text.includes('不含退款') && !text.includes('自然周'));
  if (noLongerCites) {
    result.evidence.push('✓ 删除后研究员不再引用已删除的记忆');
  } else {
    result.failures.push('✗ 删除后研究员仍引用了已删除的记忆内容');
  }

  result.pass = !!researcher && detail.memories.length >= 1 && detail.history.length >= 1
    && afterDelete.memories.length === 0 && indexClean && noLongerCites;
  return result;
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  await ensureBuiltWebServer();

  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'role-e2e-home-'));
  const dataDir = path.join(fakeHome, 'data');
  const workspaceA = path.join(fakeHome, 'workspace-a');
  const workspaceB = path.join(fakeHome, 'workspace-b');
  const env: E2EEnv = { fakeHome, dataDir, workspaceA, workspaceB };

  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await prepareEnvFile(env);
  await seedGlobalMemory(env);

  console.log(`[setup] fake HOME: ${fakeHome}`);
  console.log(`[setup] 主模型: ${MAIN_PROVIDER}/${MAIN_MODEL}（写回判断走 quick model）`);

  let server = await startServer(env);
  const results: ScenarioResult[] = [];

  const getServer = (): StartedServer => server;
  const restartServer = async (): Promise<void> => {
    await stopServer(server);
    server = await startServer(env);
  };

  try {
    // 启动后验证：预设角色已安装（installBuiltinRoles 在 webServer 启动时执行）
    const agentsInstalled = await listDirSafe(path.join(configDir(env), 'agents'));
    const rolesInstalled = await listDirSafe(path.join(configDir(env), 'roles'));
    console.log(`[setup] 预设角色安装检查: agents=[${agentsInstalled.join(', ')}] roles=[${rolesInstalled.join(', ')}]`);
    if (!agentsInstalled.includes(`${RESEARCHER}.md`) || !rolesInstalled.includes(RESEARCHER)) {
      throw new Error('预设角色未在 webServer 启动时安装 — installBuiltinRoles 接线有问题');
    }

    const printResult = (r: ScenarioResult): void => {
      console.log(`--- [${r.pass ? 'PASS' : 'FAIL'}] ${r.id} ${r.title} ---`);
      for (const e of r.evidence) console.log(`  ${e}`);
      for (const f of r.failures) console.log(`  ${f}`);
    };
    const cooldown = async (): Promise<void> => {
      console.log(`[cooldown] 等待 ${INTER_SCENARIO_COOLDOWN_MS / 1000}s（免费档 TPM 限流恢复窗口）`);
      await delay(INTER_SCENARIO_COOLDOWN_MS);
    };
    // ROLE_E2E_ONLY=AC3 或 AC1,AC4 → 只跑指定场景（单场景排障/补跑用）。
    // 注意 AC2/AC4 依赖 AC1 产生的角色记忆，单独跑时部分断言可能不成立。
    const only = process.env.ROLE_E2E_ONLY?.split(',').map((s) => s.trim().toUpperCase());
    const shouldRun = (id: string): boolean => !only || only.includes(id);

    if (shouldRun('AC1')) {
      console.log('\n========== 验收 1：研究员记忆闭环 + 重启引用 ==========');
      results.push(await scenario1(env, getServer, restartServer));
      printResult(results[results.length - 1]);
      await cooldown();
    }

    if (shouldRun('AC2')) {
      console.log('\n========== 验收 2：换角色隔离 + 全局记忆可见 ==========');
      results.push(await scenario2(env, getServer()));
      printResult(results[results.length - 1]);
      await cooldown();
    }

    if (shouldRun('AC3')) {
      console.log('\n========== 验收 3：双 workspace 项目记忆隔离 ==========');
      results.push(await scenario3(env, getServer()));
      printResult(results[results.length - 1]);
      if (shouldRun('AC4')) await cooldown();
    }

    if (shouldRun('AC4')) {
      console.log('\n========== 验收 4：角色面板 + 删除后不引用 ==========');
      results.push(await scenario4(env, getServer()));
      printResult(results[results.length - 1]);
    }
  } finally {
    // 失败排查用：把 webServer 日志尾部落盘
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
  console.log(allPass ? '\n✅ 4 条验收标准全部通过' : '\n❌ 存在未通过的验收标准');
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
