// N-ACP-CLIENT 刀1 真机 smoke：打在**正在跑的** Agent Neo Dev 槽 app 上，
// 走产品自己的选引擎 → 发消息 → 续接 → 审批链路，不另起 webServer。
//
// 用法：NEO_SLOT=3 npx tsx scripts/acceptance/kimi-acp-engine-live-smoke.ts
// ⚠️ 真实消耗 Kimi 订阅额度：3 个最小 prompt。
import { readFileSync, mkdtempSync, existsSync, appendFileSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const port = Number(process.env.ACP_SMOKE_PORT || 8195);
const baseUrl = `http://localhost:${port}`;
const nonce = `ACP${Date.now().toString(36).toUpperCase()}`;
const workspace = mkdtempSync(join(tmpdir(), 'acp-live-'));
const dataDir = mkdtempSync(join(tmpdir(), 'acp-live-data-'));
const serverLog = join(tmpdir(), `acp-live-server-${nonce}.log`);
const ENGINE_KIND = process.env.ACP_SMOKE_ENGINE || 'kimi_code_acp';
const PROFILE = process.env.ACP_SMOKE_PROFILE || 'workspace_write';

// 自起 webServer：为的是把 stderr 抓在手里——打在已运行的槽 app 上时它一崩就什么都看不到。
const repoRoot = process.cwd();
const child: ChildProcess = spawn(process.execPath, [join(repoRoot, 'dist/web/webServer.cjs')], {
  cwd: workspace,
  env: {
    ...process.env,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    CODE_AGENT_E2E: '1',
    CODE_AGENT_ENABLE_DEV_API: 'true',
    CODE_AGENT_DATA_DIR: dataDir,
    CODE_AGENT_WORKING_DIR: workspace,
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const append = (buf: Buffer) => appendFileSync(serverLog, buf.toString('utf8'));
child.stdout?.on('data', append);
child.stderr?.on('data', append);
child.on('exit', (code, signal) => {
  console.error(`\n🔴 webServer 退出 code=${code} signal=${signal}，尾部日志：`);
  try { console.error(readFileSync(serverLog, 'utf8').split('\n').slice(-40).join('\n')); } catch { /* ignore */ }
});

let token = '';
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  // 非打包路径下 .dev-token 落在 cwd（resolveDevAuthTokenPath 只在 .app/Contents/Resources 里才用 dataDir）
  for (const candidate of [join(workspace, '.dev-token'), join(dataDir, '.dev-token')]) {
    try { token = readFileSync(candidate, 'utf8').trim(); break; } catch { /* not yet */ }
  }
  if (token) {
    const ok = await fetch(`${baseUrl}/api/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!token) throw new Error('webServer 没起来');
console.log(`[acp-live] webServer 就绪，日志 ${serverLog}`);

interface DomainResponse<T> { success: boolean; data?: T; error?: { message?: string } }
async function domain<T>(domainName: string, action: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/domain/${domainName}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload }),
  });
  const result = await response.json() as DomainResponse<T>;
  if (!response.ok || !result.success) {
    throw new Error(result.error?.message || `${domainName}:${action} failed (${response.status})`);
  }
  return result.data as T;
}

async function run(sessionId: string, prompt: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, prompt, project: workspace, context: { workingDirectory: workspace } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`/api/run failed (${response.status}): ${text.slice(0, 500)}`);
  return text;
}

interface SessionShape { id: string; engine?: { kind?: string; externalSessionId?: string }; messages?: Array<{ role: string; content: string }> }

const results: Record<string, unknown> = { baseUrl, workspace, nonce };

console.log(`[acp-live] 目标 = ${baseUrl}，工作区 ${workspace}`);

// --- ①引擎可选 -------------------------------------------------------------
// 探活的 auth 子探针只有 3s 超时（VERSION_TIMEOUT_MS），`kimi provider list --json`
// 冷启动偶尔会超时 ⇒ 重试几轮，别把环境抖动读成「引擎不可选」。
let source: Record<string, unknown> | undefined;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  await domain('agentEngine', 'detect');
  const sources = await domain<Array<Record<string, unknown>>>('agentEngine', 'listSources');
  source = sources.find((s) => s.manifestId === ENGINE_KIND);
  if (source?.detected && source.selectable && source.authState === 'authenticated') break;
  console.log(`[acp-live] ① 第 ${attempt} 轮探活未就绪 authState=${source?.authState}，重试`);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('[acp-live] ① source =', JSON.stringify(source));
if (!source?.detected || !source.selectable || source.authState !== 'authenticated') {
  throw new Error(`${ENGINE_KIND} 不可选：${JSON.stringify(source)}`);
}
results.source = source;

const session = await domain<SessionShape>('session', 'create', { title: `ACP Live ${nonce}`, workingDirectory: workspace });
const sessionId = session.id;
const selected = await domain<{ kind?: string }>('agentEngine', 'select', {
  sessionId, kind: ENGINE_KIND, permissionProfile: PROFILE, workingDirectory: workspace,
});
if (selected.kind !== ENGINE_KIND) throw new Error(`选引擎没落库：${JSON.stringify(selected)}`);
if (process.env.ACP_SMOKE_STOP_AFTER_SELECT === '1') { console.log('[acp-live] 只验到选引擎，按要求停止'); child.kill('SIGTERM'); process.exit(0); }
console.log('[acp-live] ① 选中引擎 =', JSON.stringify(selected), 'session =', sessionId);
results.sessionId = sessionId;

// --- ②第一轮：纯文本 -------------------------------------------------------
try {
  await run(sessionId, `只回复这个字符串，不要解释也不要调用工具：${nonce}`);
} catch (error) {
  console.error('[acp-live] ② /api/run 抛出：', (error as Error).message, (error as { cause?: unknown }).cause);
  console.error('[acp-live] ② 等 5 秒收 webServer 退出信号…');
  await new Promise((r) => setTimeout(r, 5000));
  throw error;
}
let loaded = await domain<SessionShape>('session', 'load', { sessionId });
const first = [...(loaded.messages || [])].reverse().find((m) => m.role === 'assistant');
console.log('[acp-live] ② 第一轮回复 =', JSON.stringify(first?.content?.slice(0, 200)));
if (!first?.content?.includes(nonce)) throw new Error(`第一轮没拿到 nonce：${first?.content}`);
const externalSessionIdAfterFirst = loaded.engine?.externalSessionId;
console.log('[acp-live] ② 落库的 ACP sessionId =', externalSessionIdAfterFirst);
if (!externalSessionIdAfterFirst) throw new Error('ACP sessionId 没持久化，第二轮无法 session/load 续接');
results.firstReply = first.content;
results.externalSessionId = externalSessionIdAfterFirst;

// --- ③第二轮：续接（应走 session/load，agent 要记得上一轮）-------------------
await run(sessionId, '我刚才让你回复的那个字符串是什么？原样再说一遍，不要解释。');
loaded = await domain<SessionShape>('session', 'load', { sessionId });
const second = [...(loaded.messages || [])].reverse().find((m) => m.role === 'assistant');
console.log('[acp-live] ③ 第二轮回复 =', JSON.stringify(second?.content?.slice(0, 200)));
results.secondReply = second?.content;
results.resumeWorked = Boolean(second?.content?.includes(nonce));
console.log('[acp-live] ③ 续接成功 =', results.resumeWorked);

// --- ④第三轮：触发写盘 → 审批 ----------------------------------------------
const target = join(workspace, 'acp-live-write.txt');
const stream = await run(sessionId, `在当前目录创建文件 acp-live-write.txt，内容写 ${nonce}。`);
results.permissionRequested = stream.includes('permission_request');
results.fileWritten = existsSync(target);
console.log('[acp-live] ④ 事件流里出现 permission_request =', results.permissionRequested);
console.log('[acp-live] ④ 文件是否落盘 =', results.fileWritten, target);
if (results.fileWritten) results.fileContent = readFileSync(target, 'utf8');

console.log('\n[acp-live] ===== 汇总 =====');
console.log(JSON.stringify(results, null, 2));
console.log(`[acp-live] server 日志 = ${serverLog}`);
child.kill('SIGTERM');
process.exit(0);
