// Manual GLM probe for N-BGTASK-AGENT-DONE-CHILD-REAP-PROBE. Not a vitest file.
// Usage: npx tsx tests/manual/subagentBgReapProbe.manual.ts [a|b]
// Key: ZHIPU_CODING_API_KEY from ~/.code-agent/.env. Never print the key.
// Real SubagentExecutor + real ToolExecutor + real bash module + real backgroundTasks ledger.
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

const MARK = 'sleep 7311';
const variant = process.argv[2] === 'b' ? 'b' : 'a';
const t0 = Date.now();
const ts = () => `${new Date().toISOString()} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`;
const log = (s: string) => console.log(`[${ts()}] ${s}`);

// GLM quota was exhausted (HTTP 429 code 1310), so FAKE=1 swaps only the model for a scripted
// OpenAI-compatible endpoint; SubagentExecutor / ToolExecutor / bash / ledger stay real.
function startFakeModel(args: Record<string, unknown>): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const hasToolResult = body.includes('"role":"tool"');
        log(`fake-model request hasToolResult=${hasToolResult}`);
        const message = hasToolResult
          ? { role: 'assistant', content: 'Started sleep 7311; leaving it running.' }
          : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify(args) } }] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'glm-5.3', choices: [{ index: 0, message, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v4`, close: () => srv.close() }));
  });
}

function loadKey(): string {
  const envPath = path.join(userInfo().homedir, '.code-agent', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^ZHIPU_CODING_API_KEY=(.*)$/.exec(line.trim());
    if (m) return m[1].replace(/^"|"$/g, '').trim();
  }
  throw new Error('ZHIPU_CODING_API_KEY missing');
}
const pg = () => {
  try { return execSync(`pgrep -fl "${MARK}"`, { encoding: 'utf8' }).trim().replace(/\n/g, ' | '); } catch { return '(none)'; }
};

async function main() {
  const fake = process.env.FAKE === '1'
    ? await startFakeModel(variant === 'a' ? { command: MARK, run_in_background: true } : { command: MARK, timeout: 3000 })
    : undefined;
  const apiKey = fake ? 'fake-key' : loadKey();
  const home = mkdtempSync(path.join(tmpdir(), 'bgreap-'));
  const dataDir = path.join(home, '.code-agent');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = home; process.env.CODE_AGENT_HOME = home; process.env.CODE_AGENT_DATA_DIR = dataDir;
  const cwd = path.join(home, 'work'); mkdirSync(cwd, { recursive: true });

  const { SubagentExecutor } = await import('../../src/host/agent/subagentExecutor');
  const registry = (await import('../../src/host/tools/protocolRegistry')).getProtocolRegistry();
  const bg = await import('../../src/host/tools/shell/backgroundTasks');
  const sessionId = `parent-session-${variant}`;
  const prompt = variant === 'a'
    ? 'Use the Bash tool exactly once: command "sleep 7311", run_in_background=true. Do NOT wait, poll or kill it. Immediately after the tool returns, finish with a one-sentence final answer.'
    : 'Use the Bash tool exactly once: command "sleep 7311" in the FOREGROUND (no run_in_background) with timeout=3000 (milliseconds). When it times out/moves to background, do NOT wait, poll or kill it; finish with a one-sentence final answer.';
  const ac = new AbortController();
  bg.onBackgroundTaskLifecycleEvent((e: unknown) => { const ev = e as any; log(`ledger-event ${ev.type} ${JSON.stringify({ ...ev.task, command: String(ev.task?.command).slice(-40) })}`); });
  const events: string[] = [];
  const executor = new SubagentExecutor();
  log(`variant=${variant} agent START sessionId(parent)=${sessionId}`);
  let result: any;
  try {
    result = await executor.execute({
      prompt,
      config: { name: 'probe-agent', systemPrompt: 'You are a terse shell worker.', availableTools: ['Bash'], maxIterations: 6, maxExecutionTimeMs: 180000, permissionPreset: 'development' as never },
      context: {
        sessionId, cwd, workspace: cwd,
        modelConfig: { provider: 'zhipu', model: 'glm-5.3', apiKey, baseUrl: fake?.url ?? 'https://open.bigmodel.cn/api/coding/paas/v4', temperature: 0 } as never,
        resolver: { getDefinition: (n: string) => {
          const sc: any = registry.getSchemas().find((x) => x.name === n);
          return sc ? { name: sc.name, description: sc.description, inputSchema: sc.inputSchema, outputSchema: sc.outputSchema ?? { type: 'string' }, requiresPermission: sc.requiresPermission ?? false, permissionLevel: sc.permissionLevel, readOnly: sc.readOnly, touchesWorkDirectory: sc.touchesWorkDirectory } : undefined;
        } },
        permission: { request: async (r: any) => { log(`permission.request tool=${r.tool}`); return true; } },
        events: { emit: (ev: string, data: any) => { if (/tool/i.test(ev)) { events.push(ev); log(`event ${ev} ${JSON.stringify(data).slice(0, 200)}`); } } },
        abortSignal: ac.signal,
      } as never,
    });
  } catch (e) { log(`agent THREW ${(e as Error).message}`); }
  log(`agent COMPLETED success=${result?.success} toolsUsed=${JSON.stringify(result?.toolsUsed)} output=${String(result?.output ?? result?.error ?? '').slice(0, 200)}`);
  const failures: string[] = [];
  const snap = (label: string) => {
    log(`== ${label}: pgrep=${pg()}`);
    for (const t of bg.getAllBackgroundTasks()) log(`   ledger ${JSON.stringify({ ...t, command: t.command.slice(-40) })}`);
    if (!bg.getAllBackgroundTasks().length) log('   ledger (empty)');
    // Premise under test: after the agent completes, the child is still alive and the ledger says running.
    const alive = pg() !== '(none)';
    const running = bg.getAllBackgroundTasks().some((t) => t.status === 'running');
    if (!alive || !running) failures.push(`${label}: alive=${alive} ledgerRunning=${running}`);
  };
  try {
    snap('at completion');
    await new Promise((r) => setTimeout(r, 10_000)); snap('+10s');
    await new Promise((r) => setTimeout(r, 50_000)); snap('+60s');
  } finally {
    try { execSync(`pkill -f "${MARK}"`); } catch { /* none */ }
    log(`cleanup pgrep=${pg()}`);
  }
  if (failures.length) {
    for (const f of failures) log(`FAIL premise not held -> ${f}`);
    process.exit(1);
  }
  log('PASS premise held: child alive + ledger running at completion, +10s, +60s');
  process.exit(0);
}
main().catch((e) => { try { execSync(`pkill -f "${MARK}"`); } catch { /* */ } console.error(e); process.exit(1); });
