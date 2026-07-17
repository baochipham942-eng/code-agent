#!/usr/bin/env npx tsx
// ============================================================================
// 项目空间 E2E 验收（docs/designs/project-space.md）
// ============================================================================
//
// 纯确定性（无模型 run），验证 domain:project 在真实 headless webServer 上的全链路。
//
// 用法：
//   npm run build:web && npx tsx scripts/acceptance/project-space-e2e.ts
//
// 验收标准：
//   AC1 隐式归桶：在 workspace 建 session → 自动建 project，list 含该 project
//   AC2 1:1 绑定：同 workspace 再建 session → 同 project（不新建）；异 workspace → 新 project
//   AC3 详情聚合：detail 返回 project + goals + roles + sessionIds（session 已归入）
//   AC4 多 goal：addGoal x2 → detail.goals 两条 active；updateGoalStatus → 状态独立变更
//   AC5 角色入驻：addRole/removeRole → detail.roles 增删
//   AC6 改名/归档：rename + setStatus archived → 反映；list 默认不含 archived
//   AC7 记忆接管：~/.code-agent/projects/<key>/meta.json 写入了 projectId（只换索引）
// ============================================================================

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import { access, mkdir, mkdtemp, readFile } from 'fs/promises';
import { constants, createWriteStream } from 'fs';
import * as crypto from 'crypto';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  output: () => string;
};

interface E2EEnv {
  fakeHome: string;
  dataDir: string;
  workspace: string;
}

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
      /* ignore */
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
        const health = (await response.json()) as { status?: string };
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

async function startServer(env: E2EEnv): Promise<StartedServer> {
  const port = await getFreePort();
  const outputChunks: string[] = [];
  const logStream = createWriteStream(path.join(env.fakeHome, `webserver-${port}.log`), { flags: 'a' });
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

/** domain:project（IPC_DOMAINS.PROJECT = 'domain:project' → POST /api/domain/project/<action>） */
async function projectApi<T = unknown>(server: StartedServer, action: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${server.baseUrl}/api/domain/project/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ payload }),
  });
  const json = (await response.json()) as { success?: boolean; data?: T; error?: unknown };
  if (!json.success) throw new Error(`project/${action} failed: ${JSON.stringify(json.error)}`);
  return json.data as T;
}

async function createSession(server: StartedServer, workingDirectory: string, title: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ title, workingDirectory }),
  });
  const json = (await response.json()) as { success?: boolean; data?: { id: string }; error?: unknown };
  if (!json.success || !json.data?.id) throw new Error(`createSession failed: ${JSON.stringify(json.error ?? json)}`);
  return json.data.id;
}

function projectKey(workspacePath: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 16);
}

// ----------------------------------------------------------------------------
// 断言
// ----------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface ProjectDetail {
  project: { id: string; name: string; status: string; workspaceKey?: string | null };
  goals: Array<{ id: string; status: string; goal: string }>;
  roles: Array<{ roleId: string }>;
  sessionIds: string[];
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'project-space-e2e-'));
  const dataDir = path.join(fakeHome, 'data');
  const workspaceA = path.join(fakeHome, 'work-alpha');
  const workspaceB = path.join(fakeHome, 'work-beta');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });

  console.log(`[setup] fakeHome=${fakeHome}`);
  const server = await startServer({ fakeHome, dataDir, workspace: workspaceA });
  console.log(`[setup] server up @ ${server.baseUrl}\n`);

  try {
    // AC1 隐式归桶
    console.log('AC1 隐式归桶：建 session 自动建 project');
    const sA1 = await createSession(server, workspaceA, '会话 A1');
    const keyA = projectKey(workspaceA);
    let projects = await projectApi<Array<{ id: string; workspaceKey?: string | null }>>(server, 'list');
    const projA = projects.find((p) => p.workspaceKey === keyA);
    check('workspace A 自动建 project', !!projA, `projects=${JSON.stringify(projects.map((p) => p.workspaceKey))}`);

    // AC2 1:1 绑定
    console.log('\nAC2 1:1 绑定');
    const sA2 = await createSession(server, workspaceA, '会话 A2');
    const sB1 = await createSession(server, workspaceB, '会话 B1');
    projects = await projectApi<Array<{ id: string; workspaceKey?: string | null }>>(server, 'list');
    const projA2 = projects.filter((p) => p.workspaceKey === keyA);
    const projB = projects.find((p) => p.workspaceKey === projectKey(workspaceB));
    check('同 workspace 不新建 project（仍只 1 个）', projA2.length === 1, `count=${projA2.length}`);
    check('异 workspace 建独立 project', !!projB && projB.id !== projA!.id);

    const projectId = projA!.id;

    // AC3 详情聚合
    console.log('\nAC3 详情聚合');
    let detail = await projectApi<ProjectDetail>(server, 'detail', { projectId });
    check('detail 含两个 session（A1+A2）', detail.sessionIds.includes(sA1) && detail.sessionIds.includes(sA2), `sessionIds=${JSON.stringify(detail.sessionIds)}`);
    check('detail.sessionIds 不含 B1', !detail.sessionIds.includes(sB1));

    // AC3.1 跨 session 产物聚合端点（无产物时返回空数组，不报错）
    const arts = await projectApi<unknown[]>(server, 'artifacts', { projectId });
    check('artifacts 端点返回数组', Array.isArray(arts), `got=${typeof arts}`);

    // AC4 多 goal
    console.log('\nAC4 多 goal 并行');
    const g1 = await projectApi<{ id: string }>(server, 'addGoal', { projectId, goal: '目标一' });
    await projectApi(server, 'addGoal', { projectId, goal: '目标二', verify: 'exit 0' });
    detail = await projectApi<ProjectDetail>(server, 'detail', { projectId });
    check('两条 goal 都 active', detail.goals.length === 2 && detail.goals.every((g) => g.status === 'active'), `goals=${JSON.stringify(detail.goals.map((g) => g.status))}`);
    await projectApi(server, 'updateGoalStatus', { goalId: g1.id, status: 'met' });
    detail = await projectApi<ProjectDetail>(server, 'detail', { projectId });
    const g1after = detail.goals.find((g) => g.id === g1.id);
    const g2after = detail.goals.find((g) => g.id !== g1.id);
    check('g1 → met，g2 仍 active（独立）', g1after?.status === 'met' && g2after?.status === 'active');

    // AC5 角色入驻
    console.log('\nAC5 角色入驻（D6）');
    await projectApi(server, 'addRole', { projectId, roleId: '数据分析师' });
    await projectApi(server, 'addRole', { projectId, roleId: '研究员' });
    detail = await projectApi<ProjectDetail>(server, 'detail', { projectId });
    check('入驻 2 个角色', detail.roles.length === 2, `roles=${JSON.stringify(detail.roles.map((r) => r.roleId))}`);
    await projectApi(server, 'removeRole', { projectId, roleId: '研究员' });
    detail = await projectApi<ProjectDetail>(server, 'detail', { projectId });
    check('退出 1 个角色后剩 1', detail.roles.length === 1 && detail.roles[0].roleId === '数据分析师');

    // AC6 改名 / 归档
    console.log('\nAC6 改名 / 归档');
    await projectApi(server, 'rename', { projectId, name: '增长周报项目' });
    detail = await projectApi<ProjectDetail>(server, 'detail', { projectId });
    check('改名生效', detail.project.name === '增长周报项目');
    await projectApi(server, 'setStatus', { projectId, status: 'archived' });
    const listDefault = await projectApi<Array<{ id: string }>>(server, 'list');
    const listAll = await projectApi<Array<{ id: string }>>(server, 'list', { includeArchived: true });
    check('list 默认不含 archived', !listDefault.find((p) => p.id === projectId));
    check('list includeArchived 含 archived', !!listAll.find((p) => p.id === projectId));

    // AC7 记忆接管：meta.json 写入 projectId
    console.log('\nAC7 项目记忆接管（meta.json projectId）');
    // 项目记忆目录在 getUserConfigDir() = ~/.code-agent（HOME=fakeHome），与 sqlite dataDir 分离
    const metaPath = path.join(fakeHome, '.code-agent', 'projects', keyA, 'meta.json');
    let metaOk = false;
    let metaDetail = '';
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { projectId?: string; workspacePath?: string };
      metaOk = meta.projectId === projectId;
      metaDetail = `meta.projectId=${meta.projectId}, expected=${projectId}`;
    } catch (err) {
      metaDetail = `read ${metaPath} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    check('meta.json 写入了 projectId（记忆文件不动，只换索引）', metaOk, metaDetail);
  } finally {
    await stopServer(server);
  }

  console.log(`\n========== 结果：${passed} passed / ${failed} failed ==========`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('E2E 异常：', err);
  process.exit(1);
});
