// Manual GLM replay for N-DELEGATE-WORKDIR-LAZY-FU1-FU1. Not a vitest file.
// Usage: npx tsx tests/manual/delegateWorkdirLiveCases.manual.ts
// Key: ZHIPU_CODING_API_KEY from ~/.code-agent/.env. Never print the key.
//
// Sibling of delegateWorkdirLive.manual.ts (parent ticket). That file proved the
// design on one happy path; this one grades the real-device FB-476 shape across
// five cases, each starting from a REAL planSessionWorkDirectory path:
//   (a) pure chat — no folder ever
//   (b) delegate_task only — dispatch must not materialize
//   (c) sub-agent Bash that finishes — materialize then recycle at run end
//   (d) sub-agent Bash cancelled mid-stream — snapshot evidence keeps the folder
//   (e) sub-agent Bash that never returns (FB-476 hang shape) + restart probe:
//       a fresh process cannot recycle a folder it did not create.
//
// The executor is a stub: connector and Bash handlers are never spawned (no
// osascript runs on this machine). ToolExecutionEngine still resolves the REAL
// registered schema by name and decides whether to mkdir; AgentLoop's begin/end
// hooks recycle a metadata-only folder at run end.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import type { ToolCall, ToolResult } from '../../src/shared/contract';
import type { JSONSchema, PermissionLevel, ToolDefinition } from '../../src/shared/contract/tool';
import type { ToolSchema } from '../../src/host/protocol/tools';
import type { RuntimeContext } from '../../src/host/agent/runtime/runtimeContext';
import type { StreamSnapshot } from '../../src/host/model/providers/sseStream';

const GLM_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const GLM_MODEL = 'glm-5.3';
const REALRUN7_PROMPT = [
  '请依次做三件事：',
  '1) 在本机提醒事项里创建一条提醒，标题 fu1-reminder；',
  '2) 在本机日历里创建一个日程，标题 fu1-event，开始时间用一个近期的具体时刻；',
  '3) 写一封邮件草稿，主题 fu1-draft，收件人 me@example.com，存草稿不发送。',
  '一件一件做，每完成一件告诉我用了什么工具（工具名）、成功还是失败、失败的报错原文。',
].join('');

const ACCOUNT = userInfo().username;
const HOME_DIR = userInfo().homedir;

function scrub(text: string): string {
  return text.split(ACCOUNT).join('USER').split(HOME_DIR).join('~');
}

function loadKey(): string {
  const envPath = path.join(HOME_DIR, '.code-agent', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^ZHIPU_CODING_API_KEY=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].replace(/^"|"$/g, '').trim();
    if (!key) break;
    return key;
  }
  throw new Error('ZHIPU_CODING_API_KEY missing');
}

interface GlmToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface GlmMessage {
  content?: string | null;
  tool_calls?: GlmToolCall[];
}

function toDefinition(schema: ToolSchema): ToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema as unknown as JSONSchema,
    outputSchema: (schema.outputSchema ?? { type: 'string' }) as JSONSchema,
    requiresPermission: schema.requiresPermission ?? false,
    permissionLevel: schema.permissionLevel as PermissionLevel,
    readOnly: schema.readOnly,
    touchesWorkDirectory: schema.touchesWorkDirectory,
  };
}

async function glmChat(
  apiKey: string,
  tools: unknown[],
  messages: Array<{ role: string; content: string }>,
  toolChoice: 'auto' | 'required',
): Promise<{ model?: string; message: GlmMessage; toolChoice: 'auto' | 'required' }> {
  const response = await fetch(GLM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GLM_MODEL,
      temperature: 0,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GLM ${response.status}: ${body.slice(0, 400)}`);
  }
  const parsed = JSON.parse(body) as {
    model?: string;
    choices?: Array<{ message?: GlmMessage }>;
  };
  const message = parsed.choices?.[0]?.message;
  if (!message) throw new Error('GLM returned no message');
  return { model: parsed.model, message, toolChoice };
}

async function glmToolCalls(
  apiKey: string,
  tools: unknown[],
  messages: Array<{ role: string; content: string }>,
): Promise<{ model?: string; calls: GlmToolCall[]; text: string; toolChoice: 'auto' | 'required' }> {
  let turn = await glmChat(apiKey, tools, messages, 'auto');
  let calls = turn.message.tool_calls ?? [];
  if (calls.length === 0) {
    turn = await glmChat(apiKey, tools, messages, 'required');
    calls = turn.message.tool_calls ?? [];
  }
  return {
    model: turn.model,
    calls,
    text: turn.message.content ?? '',
    toolChoice: turn.toolChoice,
  };
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool arguments are not an object');
  }
  return parsed as Record<string, unknown>;
}

function summarizeCall(call: GlmToolCall): string {
  const name = call.function?.name ?? '(missing name)';
  const args = call.function?.arguments ?? '';
  return `${name} ${args.slice(0, 240)}`;
}

function lsRaw(target: string): string {
  try {
    return execFileSync('ls', ['-la', target], { encoding: 'utf8' });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return `${failed.stdout ?? ''}${failed.stderr ?? failed.message ?? 'ls failed'}`;
  }
}

interface EngineBundle {
  executeToolsWithHooks(calls: ToolCall[]): Promise<ToolResult[]>;
}

async function makeEngine(workingDirectory: string, sessionId: string): Promise<EngineBundle> {
  const [
    { ToolExecutionEngine },
    { AntiPatternDetector },
    { TurnState },
    { ControlState },
    { ContextHealthState },
    { RunStatsState },
    { ArtifactState },
  ] = await Promise.all([
    import('../../src/host/agent/runtime/toolExecutionEngine'),
    import('../../src/host/agent/antiPattern/detector'),
    import('../../src/host/agent/runtime/turnState'),
    import('../../src/host/agent/runtime/controlState'),
    import('../../src/host/agent/runtime/contextHealthState'),
    import('../../src/host/agent/runtime/runStatsState'),
    import('../../src/host/agent/runtime/artifactState'),
  ]);
  const execute = async (name: string): Promise<ToolResult> => ({
    toolCallId: '',
    success: true,
    output: `${name} harness-ok (stubbed: nothing executed on this machine)`,
  });
  const ctx = {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: GLM_MODEL },
    toolExecutor: { execute },
    messages: [],
    onEvent: () => undefined,
    modelRouter: {},
    maxIterations: 4,
    workingDirectory,
    isDefaultWorkingDirectory: true,
    sessionId,
    persistLongTermMemory: false,
    includeRecentConversations: false,
    circuitBreaker: {
      recordFailure: () => false,
      recordSuccess: () => undefined,
      generateWarningMessage: () => '',
      generateUserErrorMessage: () => '',
    },
    antiPatternDetector: new AntiPatternDetector(),
    goalTracker: { recordAction: () => undefined },
    nudgeManager: {
      trackModifiedFile: () => undefined,
      checkProgressState: () => undefined,
      checkPostForceExecute: () => undefined,
    },
    hookMessageBuffer: {},
    messageHistoryCompressor: {},
    autoCompressor: {},
    compressionPipeline: {},
    telemetryAdapter: {
      onTurnStart: () => undefined,
      onModelCall: () => undefined,
      onToolCallStart: () => undefined,
      onToolCallEnd: () => undefined,
      onTurnEnd: () => undefined,
    },
    turnTrace: {
      setTurn: () => undefined,
      record: () => undefined,
      flush: () => undefined,
      getEvents: () => [],
    },
    turn: TurnState.forTest({
      currentIterationSpanId: 'iteration-live',
      currentTurnId: 'turn-live',
      turnStartTime: Date.now(),
      effortLevel: 'medium' as never,
    }),
    autoApprovePlan: false,
    enableHooks: false,
    maxStopHookRetries: 0,
    maxToolCallRetries: 0,
    enableToolDeferredLoading: false,
    maxMode: false,
    maxModeCandidates: 1,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    control: ControlState.forTest({} as never),
    budgetScope: 'foreground',
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({
      traceId: 'trace-live',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      runStartTime: Date.now(),
      totalTokensUsed: 0,
      totalToolCallCount: 0,
    } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    MAX_CONSECUTIVE_COMPACTS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    artifact: ArtifactState.forTest(),
    enableDeliveryCritic: false,
  } as unknown as RuntimeContext;
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    {
      injectSystemMessage: () => undefined,
      pushPersistentSystemContext: () => undefined,
      getCurrentAttachments: () => [],
    } as never,
    { emitTaskProgress: () => undefined } as never,
    {
      setPlanMode: () => undefined,
      isPlanMode: () => false,
      generateAutoContinuationPrompt: () => '',
    } as never,
  );
  return engine;
}

type SnapshotWriter = (snapshot: StreamSnapshot) => void;

function snapshotOf(content: string, isFinal: boolean): StreamSnapshot {
  return {
    content,
    reasoning: '',
    toolCalls: [],
    estimatedTokens: Math.ceil(content.length / 4),
    timestamp: Date.now(),
    isFinal,
  };
}

async function main(): Promise<void> {
  const apiKey = loadKey();
  const outDir = path.join(HOME_DIR, 'work', 'out', 'N-DELEGATE-WORKDIR-LAZY-FU1-FU1');
  const tempHome = mkdtempSync(path.join(tmpdir(), 'delegate-workdir-cases-'));
  const dataDir = path.join(tempHome, '.code-agent');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = tempHome;
  // getHomeDir() prefers CODE_AGENT_HOME. Point it at the temp home so this
  // replay cannot mkdir the real default root.
  process.env.CODE_AGENT_HOME = tempHome;
  process.env.CODE_AGENT_DATA_DIR = dataDir;

  const logLines: string[] = [];
  const log = (text: string) => {
    const line = scrub(text);
    console.log(line);
    logLines.push(line);
  };
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };
  const lsRoot = (root: string, label: string) => {
    log(`--- ls default root ${label} ---`);
    log(lsRaw(root));
  };

  try {
    const { getDefaultWorkDirectory } = await import('../../src/host/config/configPaths');
    const { convertToolsToOpenAI } = await import('../../src/host/model/providers/shared');
    const { delegateTaskSchema } = await import('../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema');
    const { bashSchema } = await import('../../src/host/tools/modules/shell/bash.schema');
    const { planSessionWorkDirectory } = await import('../../src/host/config/sessionWorkDirectory');
    const {
      beginWorkDirectoryRun,
      endWorkDirectoryRun,
      shouldMaterializeWorkDirectoryForTool,
    } = await import('../../src/host/agent/runtime/workDirectoryMaterializer');
    const { createSnapshotHandler } = await import('../../src/host/session/streamSnapshot');
    const { getToolDefinitionWithCloudMeta } = await import('../../src/host/tools/dispatch/toolDefinitions');

    const root = getDefaultWorkDirectory();
    log(`model=${GLM_MODEL}`);
    log(`defaultRoot=${root}`);
    lsRoot(root, 'BEFORE all cases');

    // Static decision rows: the engine resolves definitions by name from the
    // real registry; log what shouldMaterializeWorkDirectoryForTool says for the
    // two tools this ticket is about (raw evidence for the H1 verdict).
    const delegateDef = getToolDefinitionWithCloudMeta(delegateTaskSchema.name);
    const bashDef = getToolDefinitionWithCloudMeta(bashSchema.name);
    log(`static delegate_task def=${delegateDef ? 'registered' : 'MISSING'} readOnly=${delegateDef?.readOnly} touchesWorkDirectory=${delegateDef?.touchesWorkDirectory} shouldMaterialize=${shouldMaterializeWorkDirectoryForTool(delegateDef)}`);
    log(`static Bash def=${bashDef ? 'registered' : 'MISSING'} readOnly=${bashDef?.readOnly} touchesWorkDirectory=${bashDef?.touchesWorkDirectory} shouldMaterialize=${shouldMaterializeWorkDirectoryForTool(bashDef)}`);

    // Each case plans its own REAL path (the same planner the web route uses),
    // so cases never collide and the folder name carries the case label.
    const plan = async (title: string): Promise<string> => planSessionWorkDirectory({
      sessionTitle: title,
      userMessage: title,
      language: 'zh',
    });
    const inferenceSnapshot = (dir: string, sessionId: string, runId: string, turnId: string): SnapshotWriter => (
      createSnapshotHandler({ workingDir: dir, sessionId, runId, turnId })
    );

    // ================= CASE (a) pure chat =================
    log('================ CASE a: pure chat ================');
    const dirA = await plan('纯聊天闲谈');
    log(`case a plannedDir=${dirA}`);
    beginWorkDirectoryRun(dirA);
    // First inference: snapshot handler runs with the planned dir still missing
    // (inference.ts builds onSnapshot at every model call). Activation must
    // fail silently (realpath ENOENT) — no folder may appear.
    const aWriter = inferenceSnapshot(dirA, 'session-case-a', 'run-case-a', 'turn-case-a-1');
    aWriter(snapshotOf('好的，我们聊聊。', true));
    const aChat = await glmChat(apiKey, [], [
      { role: 'user', content: '用一句话介绍一下你自己，不要调用任何工具。' },
    ], 'auto');
    log(`case a glm model=${aChat.model ?? 'unknown'} text=${scrub(aChat.message.content ?? '').slice(0, 160)}`);
    check(aChat.message.tool_calls === undefined, 'case a: model replied with text only (no tools offered)');
    endWorkDirectoryRun(dirA);
    log(`case a dir exists after run end=${existsSync(dirA)}`);
    lsRoot(root, 'after case a run end');
    check(!existsSync(dirA), 'case a: pure chat leaves NO folder');

    // ================= CASE (b) delegate_task only =================
    log('================ CASE b: delegate_task only ================');
    const dirB = await plan('只做派发');
    log(`case b plannedDir=${dirB}`);
    const bParentTools = convertToolsToOpenAI([toDefinition(delegateTaskSchema)]);
    beginWorkDirectoryRun(dirB);
    inferenceSnapshot(dirB, 'session-case-b', 'run-case-b', 'turn-case-b-1')(snapshotOf('我先派后台任务。', true));
    const bParent = await glmToolCalls(apiKey, bParentTools, [{ role: 'user', content: REALRUN7_PROMPT }]);
    log(`case b parent glm model=${bParent.model ?? 'unknown'} toolChoice=${bParent.toolChoice} calls=${bParent.calls.length}`);
    log(`case b parent text=${bParent.text.slice(0, 200)}`);
    for (const call of bParent.calls) log(`case b parent tool ${summarizeCall(call)}`);
    check(bParent.calls.some((call) => call.function?.name === delegateTaskSchema.name), 'case b: parent model called delegate_task');
    const bEngine = await makeEngine(dirB, 'session-case-b');
    for (const call of bParent.calls) {
      const name = call.function?.name ?? '';
      const results = await bEngine.executeToolsWithHooks([{
        id: call.id ?? `case-b-${name}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      }]);
      log(`case b engine ${name} success=${results.every((result) => result.success)} error=${results.find((result) => result.error)?.error ?? ''}`);
      log(`case b dir exists after ${name} dispatch=${existsSync(dirB)}`);
      check(!existsSync(dirB), `case b: delegate_task dispatch does NOT materialize (${name})`);
    }
    // Parent turn keeps streaming its wrap-up reply: second inference snapshot
    // handler still sees a missing dir — nothing may appear.
    inferenceSnapshot(dirB, 'session-case-b', 'run-case-b', 'turn-case-b-1')(snapshotOf('已开始，后台跑完会回流结果。', true));
    endWorkDirectoryRun(dirB);
    log(`case b dir exists after parent run end=${existsSync(dirB)}`);
    lsRoot(root, 'after case b run end');
    check(!existsSync(dirB), 'case b: delegate_task-only turn leaves NO folder');

    // ============ shared: drive a delegated sub-agent turn via GLM ============
    const subagentTurn = async (dir: string, sessionId: string, runId: string, caseLabel: string) => {
      const bashTools = convertToolsToOpenAI([toDefinition(bashSchema)]);
      const writer1 = inferenceSnapshot(dir, sessionId, runId, `${caseLabel}-t1`);
      writer1(snapshotOf('我先看一下现在的时间。', true));
      const bash = await glmToolCalls(apiKey, bashTools, [
        { role: 'system', content: '你是后台执行助手。本机没有提醒事项/日历/邮件连接器。只能用 Bash 完成用户请求，先跑 date 确认环境。不要把结果写进任何文件。' },
        { role: 'user', content: REALRUN7_PROMPT },
      ]);
      log(`${caseLabel} glm model=${bash.model ?? 'unknown'} toolChoice=${bash.toolChoice} calls=${bash.calls.length}`);
      log(`${caseLabel} text=${bash.text.slice(0, 200)}`);
      for (const call of bash.calls) log(`${caseLabel} tool ${summarizeCall(call)}`);
      check(bash.calls.some((call) => call.function?.name === bashSchema.name), `${caseLabel}: sub-agent model called Bash`);
      const engine = await makeEngine(dir, sessionId);
      for (const call of bash.calls) {
        const name = call.function?.name ?? '';
        const results = await engine.executeToolsWithHooks([{
          id: call.id ?? `${caseLabel}-${name}`,
          name,
          arguments: parseArguments(call.function?.arguments),
        }]);
        log(`${caseLabel} engine ${name} success=${results.every((result) => result.success)} error=${results.find((result) => result.error)?.error ?? ''}`);
      }
      log(`${caseLabel} dir exists after Bash dispatch=${existsSync(dir)}`);
      check(existsSync(dir), `${caseLabel}: sub-agent Bash materialized the planned dir`);
      // Second inference (after the Bash result): now the dir exists, so the
      // snapshot scaffold lands inside it — the FB-476 `.code-agent` shape.
      const writer2 = inferenceSnapshot(dir, sessionId, runId, `${caseLabel}-t2`);
      return writer2;
    };

    // ================= CASE (c) sub-agent Bash, run finishes =================
    log('================ CASE c: sub-agent Bash, run finishes ================');
    const dirC = await plan('子代理正常收尾');
    log(`case c plannedDir=${dirC}`);
    beginWorkDirectoryRun(dirC);
    const cWriter2 = await subagentTurn(dirC, 'session-case-c', 'session-work-case-c', 'case c');
    cWriter2(snapshotOf('时间已确认，继续处理提醒事项。', false));
    cWriter2(snapshotOf('三件事都办完了。', true)); // isFinal → snapshot cleared
    log('--- ls planned dir DURING case c run ---');
    log(lsRaw(dirC));
    log('--- ls .code-agent DURING case c run ---');
    log(lsRaw(path.join(dirC, '.code-agent')));
    endWorkDirectoryRun(dirC);
    log(`case c dir exists after run end=${existsSync(dirC)}`);
    lsRoot(root, 'after case c run end');
    check(!existsSync(dirC), 'case c: finishing sub-agent run RECYCLES the metadata-only folder');

    // ============ CASE (d) sub-agent Bash, cancelled mid-stream ============
    log('================ CASE d: sub-agent Bash, cancelled mid-stream ================');
    const dirD = await plan('子代理中途取消');
    log(`case d plannedDir=${dirD}`);
    beginWorkDirectoryRun(dirD);
    const dWriter2 = await subagentTurn(dirD, 'session-case-d', 'session-work-case-d', 'case d');
    // Cancelled mid-stream: a NON-final snapshot stays on disk as recovery
    // evidence (the "继续上次中断的任务" chip reads it back). endWorkDirectoryRun
    // still fires from the finally in AgentLoop.run.
    dWriter2(snapshotOf('时间已确认，正在处理提醒事', false));
    endWorkDirectoryRun(dirD);
    log(`case d dir exists after run end=${existsSync(dirD)}`);
    log('--- ls planned dir after case d run end ---');
    log(lsRaw(dirD));
    lsRoot(root, 'after case d run end');
    // By design: uncleared snapshot = recovery evidence, folder intentionally kept.
    check(existsSync(dirD), 'case d: mid-stream cancel keeps the folder (snapshot recovery evidence, by design)');

    // ============ CASE (e) sub-agent Bash, never returns (FB-476) ============
    log('================ CASE e: sub-agent Bash, never returns ================');
    const dirE = await plan('子代理挂死不返');
    log(`case e plannedDir=${dirE}`);
    beginWorkDirectoryRun(dirE);
    const eWriter2 = await subagentTurn(dirE, 'session-case-e', 'session-work-case-e', 'case e');
    // FB-476 shape: the stream after the date tool result completes (final →
    // cleared), then the NEXT tool (osascript) hangs mid-execution forever.
    // AgentLoop.run never reaches its finally → endWorkDirectoryRun never fires.
    eWriter2(snapshotOf('接下来用 osascript 处理提醒事项。', true));
    log('case e: simulating hung osascript tool call — endWorkDirectoryRun NEVER fires');
    log(`case e dir exists while run hangs=${existsSync(dirE)}`);
    log('--- ls planned dir while case e hangs ---');
    log(lsRaw(dirE));
    log('--- ls .code-agent while case e hangs ---');
    log(lsRaw(path.join(dirE, '.code-agent')));
    lsRoot(root, 'while case e hangs');
    check(existsSync(dirE), 'case e: never-ending sub-agent run leaves the metadata-only folder (H2 hang half)');

    // Restart probe: a FRESH process (app restart) imports the materializer,
    // runs one full begin/end cycle on the same dir — createdByThisProcess is
    // in-memory, so the orphan folder is never recycled. That makes the FB-476
    // leftover permanent after the app restarts.
    log('--- case e restart probe (fresh process, begin+end on the orphan dir) ---');
    const probeSource = [
      "import { existsSync } from 'node:fs';",
      "process.env.CODE_AGENT_HOME = process.argv[2];",
      "const dir = process.argv[3];",
      "const { beginWorkDirectoryRun, endWorkDirectoryRun } = await import(process.argv[4] + '/src/host/agent/runtime/workDirectoryMaterializer');",
      "beginWorkDirectoryRun(dir);",
      "endWorkDirectoryRun(dir);",
      "console.log('restart-probe dir-exists-after-later-run-end=' + existsSync(dir));",
    ].join('\n');
    const probePath = path.join(outDir, 'restart-probe.mjs');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(probePath, probeSource);
    const repoRoot = process.cwd();
    const probe = spawnSync('npx', ['tsx', probePath, tempHome, dirE, repoRoot], { encoding: 'utf8' });
    log(scrub(`${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim() || `restart probe exited ${probe.status}`));
    lsRoot(root, 'after case e restart probe');
    check(existsSync(dirE), 'case e: after app restart the orphan folder is PERMANENT (H2 restart half)');

    log('--- FINAL ls default root ---');
    log(lsRaw(root));
    const leftovers = existsSync(dirD) ? ['case d (by design: snapshot evidence)'] : [];
    if (existsSync(dirE)) leftovers.push('case e (defect shape: hung run + restart)');
    log(`leftover folders: ${leftovers.length === 0 ? 'none' : leftovers.join(' ; ')}`);

    const hardFailures = failures.filter((message) => !message.startsWith('case d:') && !message.startsWith('case e:'));
    if (hardFailures.length > 0) {
      throw new Error(`live checks failed: ${hardFailures.join('; ')}`);
    }
    log('LIVE_OK');
  } finally {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'delegate-workdir-live-cases.log'), `${logLines.join('\n')}\n`);
    rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(scrub(message));
  process.exit(1);
});
