// ============================================================================
// Codex CLI Agent Engine Adapter
// ============================================================================

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AppWindow, getLogsPath } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { AgentEventEnvelope, Message, MessageMetadata } from '../../../shared/contract';
import type {
  AgentEnginePermissionProfile,
  AgentEngineRunRequest,
  AgentEngineRunResult,
} from '../../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { getShellPath } from '../infra/shellEnvironment';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { getAgentEngineRegistry } from './agentEngineRegistry';
import { assertReadOnlyExternalProfile, assertWorkspaceCwd } from './agentEngineGuards';
import { normalizeCodexCliRunTiming } from './agentEngineTiming';
import { buildAgentEngineModelDecision } from './agentEngineModelDecision';
import { classifyAgentEngineFailure, formatAgentEngineFailureContent } from './agentEngineFailureDiagnostics';
import { assertExternalRuntimeAttachments } from '../../model/providerRuntimeCapabilities';
import { extractExternalModelUsage, type ExternalEngineDurableLifecycle } from './externalEngineDurableLifecycle';
import type { ExternalEngineResumeLaunch } from './externalEngineResumeBuilders';

const logger = createLogger('CodexCliAdapter');
const EMPTY_RESPONSE_MESSAGE = 'Codex CLI returned an empty response.';

export interface CodexCliRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  emitEvent?: (event: AgentEventEnvelope) => void;
  timeoutMs?: number;
  stallWarningMs?: number;
  durableLifecycle?: ExternalEngineDurableLifecycle;
  resumeLaunch?: ExternalEngineResumeLaunch;
}

interface CodexParsedEvent {
  textDelta?: string;
  toolName?: string;
  status?: string;
  externalSessionId?: string;
}

export class CodexCliAdapter {
  async run(request: CodexCliRunRequest): Promise<AgentEngineRunResult> {
    assertExternalRuntimeAttachments('codex_cli', request.attachmentsCount, 'Codex CLI P0');

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get('codex_cli');
    if (!descriptor.executable || descriptor.installState !== 'installed') {
      throw new Error(descriptor.lastError || 'Codex CLI is not installed or not ready.');
    }

    const permissionProfile = assertReadOnlyExternalProfile(request.permissionProfile);
    const sandbox = toCodexSandbox(permissionProfile);
    const model = request.model?.trim();
    const startedAt = Date.now();
    const runId = request.durableLifecycle?.runId ?? `codex_${startedAt}_${randomUUID().slice(0, 8)}`;
    assertResumeLaunchBinding(request.resumeLaunch, request.durableLifecycle, runId, request.sessionId, cwd);
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getSessionManager();
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', 'codex-cli');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const commandSummary = request.resumeLaunch?.commandSummary ?? [
      'codex exec',
      '--json',
      ...(model ? [`--model ${model}`] : []),
      `--sandbox ${sandbox}`,
      `-C ${cwd}`,
      '<prompt:redacted>',
    ].join(' ');
    const timing = normalizeCodexCliRunTiming({
      timeoutMs: request.timeoutMs,
      stallWarningMs: request.stallWarningMs,
    });

    if (!request.resumeLaunch || request.resumeLaunch.stdin !== undefined) {
      const userMessage: Message = {
        id: request.clientMessageId || generateMessageId(),
        role: 'user',
        content: request.resumeLaunch?.stdin ?? request.prompt,
        timestamp: startedAt,
        metadata: request.messageMetadata,
      };
      await sessionManager.addMessageToSession(request.sessionId, userMessage);
    }

    await sessionManager.updateSession(request.sessionId, {
      status: 'running',
      engine: normalizeAgentEngineSession({
        kind: 'codex_cli',
        model,
        runId,
        logPath,
        cwd,
        permissionProfile,
        origin: 'manual',
        updatedAt: startedAt,
      }),
      updatedAt: startedAt,
    }, { allowEngineUpdate: true });

    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: request.sessionId,
      runId,
      source: 'agent_engine',
      title: 'Codex CLI',
      summary: 'Codex CLI engine run',
      command: commandSummary,
      cwd,
      status: 'running',
      startedAt,
      metadata: {
        engine: 'codex_cli',
        ...(model ? { model } : {}),
        permissionProfile,
        env: summarizeEnv(buildSafeEnv()),
        logPath,
        timeoutMs: timing.timeoutMs,
        stallWarningMs: timing.stallWarningMs,
      },
    });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.started',
      status: 'running',
      message: 'Codex CLI run started',
      data: { runId, cwd, permissionProfile, model },
    });

    const emit = (event: AgentEventEnvelope) => emitAgentEvent(request.sessionId, event, request.emitEvent);

    emit({
      type: 'turn_start',
      data: { turnId, iteration: 1 },
    });

    const args = request.resumeLaunch?.args ?? buildCodexCliArgs({ model, sandbox, cwd, lastMessagePath });

    const env = buildSafeEnv();
    const child = spawn(descriptor.binaryPath || 'codex', args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await request.durableLifecycle?.attachProcess(child, {
      binary: descriptor.binaryPath || 'codex',
      version: descriptor.version,
      commandSummary,
      logPath,
      model,
      permissionProfile,
    });
    child.stdin.end(request.resumeLaunch?.stdin ?? (request.resumeLaunch ? undefined : request.prompt));

    let stdoutBuffer = '';
    let stderrText = '';
    let streamedText = '';
    let spawnErrorMessage: string | undefined;
    let resumeIdentityError: string | undefined;
    let observedExternalSessionId: string | undefined;
    let timeoutMessage: string | undefined;
    let stalled = false;

    const markRunningAfterStall = () => {
      if (!stalled || timeoutMessage) return;
      stalled = false;
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.resumed',
        status: 'running',
        message: 'Codex CLI produced output after a slow start',
      });
    };

    const stallTimer = setTimeout(() => {
      stalled = true;
      ledger.upsertTask({
        id: taskId,
        status: 'stalled',
        progress: {
          label: 'Codex CLI slow start',
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.stalled',
        status: 'stalled',
        message: `Codex CLI has not completed after ${Math.round(timing.stallWarningMs / 1000)}s`,
        data: { runId, logPath },
      });
    }, timing.stallWarningMs);

    const timeoutTimer = setTimeout(() => {
      timeoutMessage = `Codex CLI timed out after ${Math.round(timing.timeoutMs / 1000)}s`;
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.timeout',
        status: 'failed',
        message: timeoutMessage,
        data: { runId, logPath },
      });
      if (request.durableLifecycle) void request.durableLifecycle.terminateProcess('SIGTERM');
      else child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) {
          if (request.durableLifecycle) void request.durableLifecycle.terminateProcess('SIGKILL');
          else child.kill('SIGKILL');
        }
      }, 2_000).unref?.();
    }, timing.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      markRunningAfterStall();
      const text = chunk.toString('utf8');
      request.durableLifecycle?.observeStdout(chunk.byteLength);
      logStream.write(text);
      stdoutBuffer += text;
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() ?? '';
      for (const line of parts) {
        const parsed = parseCodexJsonLine(line);
        const usage = extractExternalModelUsage(line);
        if (usage) request.durableLifecycle?.observeModelUsage(usage.inputTokens, usage.outputTokens);
        if (parsed?.externalSessionId) {
          observedExternalSessionId = parsed.externalSessionId;
          if (request.resumeLaunch && parsed.externalSessionId !== request.resumeLaunch.externalSessionId) {
            resumeIdentityError = 'Codex resumed a different external session';
            void request.durableLifecycle?.terminateProcess('SIGTERM');
          } else {
            request.durableLifecycle?.persistExternalSessionId(parsed.externalSessionId);
          }
        }
        if (parsed?.textDelta) {
          request.durableLifecycle?.observeNormalizedEvent('text_delta');
          streamedText += parsed.textDelta;
          emit({
            type: 'message_delta',
            data: { role: 'assistant', path: 'content', text: parsed.textDelta, op: 'append', turnId },
          });
        }
        if (parsed?.toolName) {
          request.durableLifecycle?.observeNormalizedEvent('tool_call', parsed.toolName);
          ledger.appendEvent({
            taskId,
            type: 'agent_engine.tool_call',
            status: 'running',
            message: parsed.toolName,
          });
        }
        if (parsed?.status) {
          request.durableLifecycle?.observeNormalizedEvent('status', parsed.status);
          ledger.appendEvent({
            taskId,
            type: 'agent_engine.status',
            status: 'running',
            message: parsed.status,
          });
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      markRunningAfterStall();
      const text = chunk.toString('utf8');
      request.durableLifecycle?.observeStderr(chunk.byteLength);
      stderrText += text;
      logStream.write(text);
    });

    child.on('error', (error) => {
      spawnErrorMessage = error.message;
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });
    clearTimeout(stallTimer);
    clearTimeout(timeoutTimer);

    if (stdoutBuffer.trim()) {
      const parsed = parseCodexJsonLine(stdoutBuffer);
      const usage = extractExternalModelUsage(stdoutBuffer);
      if (usage) request.durableLifecycle?.observeModelUsage(usage.inputTokens, usage.outputTokens);
      if (parsed?.externalSessionId) {
        observedExternalSessionId = parsed.externalSessionId;
        if (request.resumeLaunch && parsed.externalSessionId !== request.resumeLaunch.externalSessionId) {
          resumeIdentityError = 'Codex resumed a different external session';
        } else {
          request.durableLifecycle?.persistExternalSessionId(parsed.externalSessionId);
        }
      }
      if (parsed?.textDelta) {
        streamedText += parsed.textDelta;
        emit({
          type: 'message_delta',
          data: { role: 'assistant', path: 'content', text: parsed.textDelta, op: 'append', turnId },
        });
      }
    }

    await new Promise<void>((resolve) => logStream.end(resolve));

    const finalText = await readFileIfExists(lastMessagePath) || streamedText.trim();
    const completedAt = Date.now();
    if (request.resumeLaunch && !observedExternalSessionId && !resumeIdentityError) {
      resumeIdentityError = 'Codex resume did not confirm the external session identity';
    }
    const emptyResponse = !finalText && !timeoutMessage && !spawnErrorMessage && exitCode === 0;
    const failed = Boolean(timeoutMessage || spawnErrorMessage || resumeIdentityError || exitCode !== 0 || emptyResponse);

    ledger.addOutputRef({
      taskId,
      type: 'log',
      label: 'Codex CLI log',
      path: logPath,
      mimeType: 'text/plain',
    });
    if (finalText) {
      ledger.addOutputRef({
        taskId,
        type: 'text',
        label: 'Codex final message',
        path: lastMessagePath,
        mimeType: 'text/markdown',
      });
    }

    if (failed) {
      const message = timeoutMessage
        || spawnErrorMessage
        || resumeIdentityError
        || (emptyResponse ? EMPTY_RESPONSE_MESSAGE : '')
        || stderrText.trim()
        || `Codex CLI exited with code ${exitCode}`;
      const failureDiagnostics = classifyAgentEngineFailure({
        engine: 'codex_cli',
        message,
        exitCode,
        occurredAt: completedAt,
        timeout: Boolean(timeoutMessage),
        spawnError: Boolean(spawnErrorMessage),
      });
      ledger.upsertTask({
        id: taskId,
        status: 'failed',
        completedAt,
        durationMs: completedAt - startedAt,
        failure: {
          message,
          exitCode: exitCode ?? undefined,
          category: 'agent_engine',
          reason: failureDiagnostics.reason,
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.failed',
        status: 'failed',
        message,
        data: { exitCode, logPath, failure: failureDiagnostics },
      });
      ledger.queueNotification({
        taskId,
        sessionId: request.sessionId,
        type: 'task_failed',
        title: 'Codex CLI failed',
        message,
        payload: { runId, logPath, failure: failureDiagnostics },
      });
      emit({
        type: 'error',
        data: { message, code: 'CODEX_CLI_FAILED', suggestion: failureDiagnostics.suggestion, details: { runId, logPath, exitCode, failure: failureDiagnostics } },
      });
      const assistantMessage: Message = {
        id: turnId,
        role: 'assistant',
        content: formatAgentEngineFailureContent(descriptor.label, failureDiagnostics, logPath),
        timestamp: completedAt,
        modelDecision: buildAgentEngineModelDecision(descriptor, model, completedAt, failureDiagnostics),
        metadata: {
          workbench: {
            workingDirectory: cwd,
          },
        },
      };
      await sessionManager.addMessageToSession(request.sessionId, assistantMessage);
      emit({
        type: 'message',
        data: assistantMessage,
      });
      emit({
        type: 'turn_end',
        data: { turnId },
      });
      await sessionManager.updateSession(request.sessionId, {
        status: 'error',
        engine: normalizeAgentEngineSession({
          kind: 'codex_cli',
          model,
          runId,
          logPath,
          cwd,
          permissionProfile,
          origin: 'manual',
          updatedAt: completedAt,
          failure: failureDiagnostics,
        }),
        updatedAt: completedAt,
      }, { allowEngineUpdate: true });
      emit({ type: 'agent_complete', data: null });
      const result: AgentEngineRunResult = {
        runId,
        sessionId: request.sessionId,
        engine: 'codex_cli',
        status: 'failed',
        outputText: finalText,
        logPath,
        exitCode,
        error: message,
        failure: failureDiagnostics,
      };
      await request.durableLifecycle?.finish(result, Boolean(timeoutMessage || spawnErrorMessage || exitCode !== 0));
      return result;
    }

    const assistantMessage: Message = {
      id: turnId,
      role: 'assistant',
      content: finalText || 'Codex CLI completed without text output.',
      timestamp: completedAt,
      modelDecision: buildAgentEngineModelDecision(descriptor, model, completedAt),
      metadata: {
        workbench: {
          workingDirectory: cwd,
        },
      },
    };
    await sessionManager.addMessageToSession(request.sessionId, assistantMessage);

    emit({
      type: 'message',
      data: assistantMessage,
    });
    emit({
      type: 'turn_end',
      data: { turnId },
    });
    emit({
      type: 'agent_complete',
      data: null,
    });

    ledger.upsertTask({
      id: taskId,
      status: 'completed',
      completedAt,
      durationMs: completedAt - startedAt,
    });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.completed',
      status: 'completed',
      message: 'Codex CLI run completed',
      data: { runId, logPath },
    });
    ledger.queueNotification({
      taskId,
      sessionId: request.sessionId,
      type: 'task_completed',
      title: 'Codex CLI completed',
      message: 'Codex CLI run completed',
      payload: { runId, logPath },
    });

    await sessionManager.updateSession(request.sessionId, {
      status: 'idle',
      engine: normalizeAgentEngineSession({
        kind: 'codex_cli',
        model,
        runId,
        logPath,
        cwd,
        permissionProfile,
        origin: 'manual',
        updatedAt: completedAt,
      }),
      updatedAt: completedAt,
    }, { allowEngineUpdate: true });

    const result: AgentEngineRunResult = {
      runId,
      sessionId: request.sessionId,
      engine: 'codex_cli',
      status: 'completed',
      outputText: assistantMessage.content,
      logPath,
      exitCode,
    };
    await request.durableLifecycle?.finish(result, Boolean(finalText));
    return result;
  }
}

function assertResumeLaunchBinding(
  launch: ExternalEngineResumeLaunch | undefined,
  lifecycle: ExternalEngineDurableLifecycle | undefined,
  runId: string,
  sessionId: string,
  cwd: string,
): void {
  if (!launch) return;
  if (!lifecycle) throw new Error('Codex resume requires a durable recovery lifecycle');
  if (launch.runId !== runId || launch.sessionId !== sessionId || launch.cwd !== cwd) {
    throw new Error('Codex resume launch has a stale logical run, session, or cwd binding');
  }
  if (launch.attempt !== lifecycle.attempt || launch.ownerEpoch !== lifecycle.ownerEpoch) {
    throw new Error('Codex resume launch has a stale attempt or owner epoch');
  }
}

function toCodexSandbox(profile: AgentEnginePermissionProfile): 'read-only' | 'workspace-write' {
  return profile === 'workspace_write' ? 'workspace-write' : 'read-only';
}

export function buildCodexCliArgs(input: {
  model?: string | null;
  sandbox: 'read-only' | 'workspace-write';
  cwd: string;
  lastMessagePath: string;
}): string[] {
  return [
    'exec',
    '--json',
    ...(input.model?.trim() ? ['--model', input.model.trim()] : []),
    '--sandbox',
    input.sandbox,
    '--skip-git-repo-check',
    '-C',
    input.cwd,
    '--output-last-message',
    input.lastMessagePath,
    '-',
  ];
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const allowExact = new Set(['HOME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'LANG']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (allowExact.has(key) || key === 'CODEX_HOME' || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value;
    }
  }
  // PATH 用 login shell 捕获的完整 PATH（与 registry 探测同源）。Finder/launchd 启动的打包 app
  // process.env.PATH 只有系统目录，codex 的 #!/usr/bin/env node shebang 找不到 node 会直接
  // 报 "env: node: No such file or directory"——探测能找到 binary 但执行挂掉的不对称就出在这。
  env.PATH = getShellPath();
  return env;
}

function summarizeEnv(env: NodeJS.ProcessEnv): { keys: string[]; redacted: string[] } {
  const keys = Object.keys(env).sort();
  return {
    keys,
    redacted: Object.keys(process.env)
      .filter((key) => !keys.includes(key))
      .filter((key) => /(TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key))
      .sort(),
  };
}

function parseCodexJsonLine(line: string): CodexParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  return extractCodexEvent(event as Record<string, unknown>);
}

function extractCodexEvent(event: Record<string, unknown>): CodexParsedEvent {
  const type = typeof event.type === 'string' ? event.type : undefined;
  const msg = isRecord(event.msg) ? event.msg : undefined;
  const item = isRecord(event.item) ? event.item : isRecord(msg?.item) ? msg.item : undefined;
  const data = isRecord(event.data) ? event.data : isRecord(msg?.data) ? msg.data : undefined;

  const textDelta = firstString(
    event.delta,
    event.text,
    data?.text,
    data?.delta,
    msg?.delta,
    msg?.text,
    extractMessageText(item),
  );

  const toolName = firstString(
    data?.name,
    msg?.name,
    item?.name,
    isRecord(item?.function) ? item.function.name : undefined,
  );

  return {
    ...(textDelta && isTextLikeType(type, event, msg) ? { textDelta } : {}),
    ...(toolName && isToolLikeType(type, item, msg) ? { toolName } : {}),
    ...(typeof type === 'string' && type.includes('status') ? { status: firstString(data?.status, msg?.status, type) } : {}),
    ...(firstString(event.thread_id, event.threadId, event.session_id, event.sessionId, data?.thread_id, msg?.thread_id)
      ? { externalSessionId: firstString(event.thread_id, event.threadId, event.session_id, event.sessionId, data?.thread_id, msg?.thread_id) }
      : {}),
  };
}

function isTextLikeType(type: string | undefined, event: Record<string, unknown>, msg?: Record<string, unknown>): boolean {
  const joined = [type, event.role, msg?.role, event.type, msg?.type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return joined.includes('assistant')
    || joined.includes('message')
    || joined.includes('text')
    || joined.includes('delta')
    || joined.includes('response');
}

function isToolLikeType(type: string | undefined, item?: Record<string, unknown>, msg?: Record<string, unknown>): boolean {
  const joined = [type, item?.type, msg?.type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return joined.includes('tool') || joined.includes('function') || joined.includes('exec');
}

function extractMessageText(item?: Record<string, unknown>): string | undefined {
  const content = item?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      return firstString(part.text, part.content, part.output_text) || '';
    })
    .join('');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim();
  } catch {
    return undefined;
  }
}

function emitAgentEvent(
  sessionId: string,
  event: AgentEventEnvelope,
  localSink?: (event: AgentEventEnvelope) => void,
): void {
  localSink?.(event);
  const payload = {
    ...event,
    sessionId,
  };
  for (const win of AppWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.AGENT_EVENT, payload);
  }
}
