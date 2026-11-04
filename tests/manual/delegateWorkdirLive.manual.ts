// Manual GLM replay for N-DELEGATE-WORKDIR-LAZY. Not a vitest file.
// Usage: npx tsx tests/manual/delegateWorkdirLive.manual.ts
// Key: ZHIPU_CODING_API_KEY from ~/.code-agent/.env. Never print the key.
//
// The executor is a stub: connector and Bash handlers are not spawned (osascript
// hangs this machine). ToolExecutionEngine still decides whether to mkdir, and
// AgentLoop's begin/end hooks recycle a metadata-only folder at run end.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import type { ToolCall, ToolResult } from '../../src/shared/contract';
import type { JSONSchema, PermissionLevel, ToolDefinition } from '../../src/shared/contract/tool';
import type { ToolSchema } from '../../src/host/protocol/tools';
import type { RuntimeContext } from '../../src/host/agent/runtime/runtimeContext';

const GLM_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const GLM_MODEL = 'glm-5.3';
const REALRUN4_PROMPT = [
  '请依次做三件事：',
  '1) 在本机提醒事项里创建一条提醒，标题 realrun4-reminder；',
  '2) 在本机邮件里创建一封草稿，主题 realrun4-draft，收件人 me@example.com；',
  '3) 在本机日历里创建一个日程，标题 realrun4-event，开始时间用一个近期的具体时刻。',
  '一件一件做，每完成一件告诉我用了什么工具（工具名）、成功还是失败、失败的报错原文。',
].join('');

const ACCOUNT = userInfo().username;

function scrub(text: string): string {
  return text.split(ACCOUNT).join('USER');
}

function loadKey(): string {
  const envPath = path.join(userInfo().homedir, '.code-agent', '.env');
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
      tools,
      tool_choice: toolChoice,
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

async function makeEngine(workingDirectory: string): Promise<EngineBundle> {
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
    output: `${name} harness-ok`,
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
    sessionId: 'session-delegate-workdir-live',
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

async function main(): Promise<void> {
  const apiKey = loadKey();
  const outDir = path.join(userInfo().homedir, 'work', 'out', 'N-DELEGATE-WORKDIR-LAZY');
  const tempHome = mkdtempSync(path.join(tmpdir(), 'delegate-workdir-live-'));
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

  try {
    const { getDefaultWorkDirectory } = await import('../../src/host/config/configPaths');
    const { convertToolsToOpenAI } = await import('../../src/host/model/providers/shared');
    const { delegateTaskSchema } = await import('../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema');
    const { remindersCreateSchema } = await import('../../src/host/tools/modules/connectors/remindersCreate.schema');
    const { mailDraftSchema } = await import('../../src/host/tools/modules/connectors/mailDraft.schema');
    const { calendarCreateEventSchema } = await import('../../src/host/tools/modules/connectors/calendarCreateEvent.schema');
    const { bashSchema } = await import('../../src/host/tools/modules/shell/bash.schema');
    const { beginWorkDirectoryRun, endWorkDirectoryRun } = await import('../../src/host/agent/runtime/workDirectoryMaterializer');
    const { createSnapshotHandler } = await import('../../src/host/session/streamSnapshot');

    const root = getDefaultWorkDirectory();
    const connectorDir = path.join(root, '任务_1027_连接器子轮');
    const bashDir = path.join(root, '任务_1027_Bash子轮');
    log(`model=${GLM_MODEL}`);
    log(`defaultRoot=${root}`);
    log('--- ls default root BEFORE ---');
    log(lsRaw(root));

    const parentTools = convertToolsToOpenAI([toDefinition(delegateTaskSchema)]);
    const parent = await glmToolCalls(apiKey, parentTools, [{ role: 'user', content: REALRUN4_PROMPT }]);
    log(`parent glm model=${parent.model ?? 'unknown'} toolChoice=${parent.toolChoice} calls=${parent.calls.length}`);
    log(`parent text=${parent.text.slice(0, 300)}`);
    for (const call of parent.calls) log(`parent tool ${summarizeCall(call)}`);
    check(parent.calls.length > 0, 'parent GLM returned a tool call');

    const parentEngine = await makeEngine(connectorDir);
    beginWorkDirectoryRun(connectorDir);
    for (const call of parent.calls) {
      const name = call.function?.name ?? '';
      const results = await parentEngine.executeToolsWithHooks([{
        id: call.id ?? `parent-${name}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      }]);
      log(`parent engine ${name} success=${results.every((result) => result.success)} error=${results.find((result) => result.error)?.error ?? ''}`);
      log(`--- ls default root after parent ${name} ---`);
      log(lsRaw(root));
      check(!existsSync(connectorDir), `connector dir absent after parent ${name}`);
    }
    endWorkDirectoryRun(connectorDir);
    log('--- ls default root after parent run end ---');
    log(lsRaw(root));
    check(!existsSync(connectorDir), 'connector dir absent after parent run end');

    const childPrompt = (() => {
      const delegated = parent.calls.find((call) => call.function?.name === 'delegate_task');
      if (!delegated) return REALRUN4_PROMPT;
      const args = parseArguments(delegated.function?.arguments);
      return typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt : REALRUN4_PROMPT;
    })();
    log(`child prompt source=${childPrompt === REALRUN4_PROMPT ? 'realrun4' : 'delegate_task.prompt'} chars=${childPrompt.length}`);

    const connectorTools = convertToolsToOpenAI([
      toDefinition(remindersCreateSchema),
      toDefinition(mailDraftSchema),
      toDefinition(calendarCreateEventSchema),
    ]);
    const connector = await glmToolCalls(apiKey, connectorTools, [
      { role: 'system', content: '你是后台执行助手。只能使用提供的连接器工具，不要写文件。一件一件调用工具，并告诉我工具名。' },
      { role: 'user', content: childPrompt },
    ]);
    log(`connector glm model=${connector.model ?? 'unknown'} toolChoice=${connector.toolChoice} calls=${connector.calls.length}`);
    log(`connector text=${connector.text.slice(0, 300)}`);
    const connectorNames = connector.calls.map((call) => call.function?.name ?? '(missing)');
    log(`connector tool names=${connectorNames.join(',')}`);
    for (const call of connector.calls) log(`connector tool ${summarizeCall(call)}`);
    check(connector.calls.length > 0, 'connector child GLM returned a tool call');
    check(connectorNames.every((name) => name !== 'Bash'), 'connector child did not call Bash');

    const connectorEngine = await makeEngine(connectorDir);
    beginWorkDirectoryRun(connectorDir);
    log('--- ls default root connector run start ---');
    log(lsRaw(root));
    check(!existsSync(connectorDir), 'connector dir absent at child run start');
    for (const call of connector.calls) {
      const name = call.function?.name ?? '';
      const results = await connectorEngine.executeToolsWithHooks([{
        id: call.id ?? `connector-${name}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      }]);
      log(`connector engine ${name} success=${results.every((result) => result.success)} error=${results.find((result) => result.error)?.error ?? ''}`);
      log(`--- ls default root after connector ${name} ---`);
      log(lsRaw(root));
      check(!existsSync(connectorDir), `connector dir absent after ${name}`);
    }
    endWorkDirectoryRun(connectorDir);
    log('--- ls default root after connector run end ---');
    log(lsRaw(root));
    check(!existsSync(connectorDir), 'connector dir absent after connector run end');

    const bashTools = convertToolsToOpenAI([toDefinition(bashSchema)]);
    const bash = await glmToolCalls(apiKey, bashTools, [
      { role: 'system', content: '你是后台执行助手。连接器不可用。只用 Bash 完成用户请求，不要把结果写进任何文件。一件一件调用工具，并告诉我工具名。' },
      { role: 'user', content: childPrompt },
    ]);
    log(`bash glm model=${bash.model ?? 'unknown'} toolChoice=${bash.toolChoice} calls=${bash.calls.length}`);
    log(`bash text=${bash.text.slice(0, 300)}`);
    const bashNames = bash.calls.map((call) => call.function?.name ?? '(missing)');
    log(`bash tool names=${bashNames.join(',')}`);
    for (const call of bash.calls) log(`bash tool ${summarizeCall(call)}`);
    check(bash.calls.some((call) => call.function?.name === 'Bash'), 'bash child GLM called Bash');

    const bashEngine = await makeEngine(bashDir);
    beginWorkDirectoryRun(bashDir);
    for (const call of bash.calls) {
      const name = call.function?.name ?? '';
      const results = await bashEngine.executeToolsWithHooks([{
        id: call.id ?? `bash-${name}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      }]);
      log(`bash engine ${name} success=${results.every((result) => result.success)} error=${results.find((result) => result.error)?.error ?? ''}`);
    }
    check(existsSync(bashDir), 'bash child materialized the planned dir during the run');
    if (existsSync(bashDir)) {
      createSnapshotHandler({
        workingDir: bashDir,
        sessionId: 'live-bash',
        runId: 'live-bash-run',
        turnId: 'live-bash-turn',
      });
    }
    log('--- ls planned bash dir DURING run ---');
    log(lsRaw(bashDir));
    log('--- ls .code-agent DURING run ---');
    log(lsRaw(path.join(bashDir, '.code-agent')));
    log('--- ls default root DURING bash run ---');
    log(lsRaw(root));
    endWorkDirectoryRun(bashDir);
    log('--- ls default root AFTER bash run end ---');
    log(lsRaw(root));
    log('--- ls planned bash dir AFTER run end ---');
    log(lsRaw(bashDir));
    check(!existsSync(bashDir), 'bash child dir is gone after the run ends');
    check(!existsSync(connectorDir), 'connector dir still absent at the end');

    if (failures.length > 0) {
      throw new Error(`live checks failed: ${failures.join('; ')}`);
    }
    log('LIVE_OK');
  } finally {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'delegate-workdir-live.log'), `${logLines.join('\n')}\n`);
    rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(scrub(message));
  process.exit(1);
});
