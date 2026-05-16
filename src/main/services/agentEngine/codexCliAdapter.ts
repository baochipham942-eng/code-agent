// ============================================================================
// Codex CLI Agent Engine Adapter
// ============================================================================

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { BrowserWindow, getLogsPath } from '../../platform';
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
import { getBackgroundTaskLedger } from '../../tasks/backgroundTaskLedger';
import { ReviewQueueService } from '../../evaluation/reviewQueueService';
import { getAgentEngineRegistry } from './agentEngineRegistry';
import { assertReadOnlyExternalProfile, assertWorkspaceCwd } from './agentEngineGuards';
import { normalizeCodexCliRunTiming } from './agentEngineTiming';

const logger = createLogger('CodexCliAdapter');

export interface CodexCliRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  emitEvent?: (event: AgentEventEnvelope) => void;
  timeoutMs?: number;
  stallWarningMs?: number;
}

interface CodexParsedEvent {
  textDelta?: string;
  toolName?: string;
  status?: string;
}

export class CodexCliAdapter {
  async run(request: CodexCliRunRequest): Promise<AgentEngineRunResult> {
    if (request.attachmentsCount && request.attachmentsCount > 0) {
      throw new Error('Codex CLI engine P0 only supports text prompts.');
    }

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get('codex_cli');
    if (!descriptor.executable || descriptor.installState !== 'installed') {
      throw new Error(descriptor.lastError || 'Codex CLI is not installed or not ready.');
    }

    const permissionProfile = assertReadOnlyExternalProfile(request.permissionProfile);
    const sandbox = toCodexSandbox(permissionProfile);
    const startedAt = Date.now();
    const runId = `codex_${startedAt}_${randomUUID().slice(0, 8)}`;
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getSessionManager();
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', 'codex-cli');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const commandSummary = `codex exec --json --sandbox ${sandbox} -C ${cwd} <prompt:redacted>`;
    const timing = normalizeCodexCliRunTiming({
      timeoutMs: request.timeoutMs,
      stallWarningMs: request.stallWarningMs,
    });

    const userMessage: Message = {
      id: request.clientMessageId || generateMessageId(),
      role: 'user',
      content: request.prompt,
      timestamp: startedAt,
      metadata: request.messageMetadata,
    };
    await sessionManager.addMessageToSession(request.sessionId, userMessage);

    await sessionManager.updateSession(request.sessionId, {
      status: 'running',
      engine: normalizeAgentEngineSession({
        kind: 'codex_cli',
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
      data: { runId, cwd, permissionProfile },
    });

    const emit = (event: AgentEventEnvelope) => emitAgentEvent(request.sessionId, event, request.emitEvent);

    emit({
      type: 'turn_start',
      data: { turnId, iteration: 1 },
    });

    const args = [
      'exec',
      '--json',
      '--sandbox',
      sandbox,
      '--skip-git-repo-check',
      '-C',
      cwd,
      '--output-last-message',
      lastMessagePath,
      '-',
    ];

    const env = buildSafeEnv();
    const child = spawn(descriptor.binaryPath || 'codex', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(request.prompt);

    let stdoutBuffer = '';
    let stderrText = '';
    let streamedText = '';
    let spawnErrorMessage: string | undefined;
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
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 2_000).unref?.();
    }, timing.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      markRunningAfterStall();
      const text = chunk.toString('utf8');
      logStream.write(text);
      stdoutBuffer += text;
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() ?? '';
      for (const line of parts) {
        const parsed = parseCodexJsonLine(line);
        if (parsed?.textDelta) {
          streamedText += parsed.textDelta;
          emit({
            type: 'message_delta',
            data: { role: 'assistant', path: 'content', text: parsed.textDelta, op: 'append', turnId },
          });
        }
        if (parsed?.toolName) {
          ledger.appendEvent({
            taskId,
            type: 'agent_engine.tool_call',
            status: 'running',
            message: parsed.toolName,
          });
        }
        if (parsed?.status) {
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
    const failed = Boolean(timeoutMessage || spawnErrorMessage || exitCode !== 0);

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
      const message = timeoutMessage || spawnErrorMessage || stderrText.trim() || `Codex CLI exited with code ${exitCode}`;
      ledger.upsertTask({
        id: taskId,
        status: 'failed',
        completedAt,
        durationMs: completedAt - startedAt,
        failure: {
          message,
          exitCode: exitCode ?? undefined,
          category: 'agent_engine',
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.failed',
        status: 'failed',
        message,
        data: { exitCode, logPath },
      });
      ledger.queueNotification({
        taskId,
        sessionId: request.sessionId,
        type: 'task_failed',
        title: 'Codex CLI failed',
        message,
        payload: { runId, logPath },
      });
      enqueueFailureReview(request.sessionId, message);
      emit({
        type: 'error',
        data: { message, code: 'CODEX_CLI_FAILED', details: { runId, logPath, exitCode } },
      });
      await sessionManager.updateSession(request.sessionId, {
        status: 'error',
        engine: normalizeAgentEngineSession({
          kind: 'codex_cli',
          runId,
          logPath,
          cwd,
          permissionProfile,
          origin: 'manual',
          updatedAt: completedAt,
        }),
        updatedAt: completedAt,
      }, { allowEngineUpdate: true });
      emit({ type: 'agent_complete', data: null });
      return {
        runId,
        sessionId: request.sessionId,
        engine: 'codex_cli',
        status: 'failed',
        outputText: finalText,
        logPath,
        exitCode,
        error: message,
      };
    }

    const assistantMessage: Message = {
      id: turnId,
      role: 'assistant',
      content: finalText || 'Codex CLI completed without text output.',
      timestamp: completedAt,
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
        runId,
        logPath,
        cwd,
        permissionProfile,
        origin: 'manual',
        updatedAt: completedAt,
      }),
      updatedAt: completedAt,
    }, { allowEngineUpdate: true });

    return {
      runId,
      sessionId: request.sessionId,
      engine: 'codex_cli',
      status: 'completed',
      outputText: assistantMessage.content,
      logPath,
      exitCode,
    };
  }
}

function toCodexSandbox(profile: AgentEnginePermissionProfile): 'read-only' | 'workspace-write' {
  return profile === 'workspace_write' ? 'workspace-write' : 'read-only';
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
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.AGENT_EVENT, payload);
  }
}

function enqueueFailureReview(sessionId: string, summary: string): void {
  try {
    ReviewQueueService.getInstance().enqueueSession({
      sessionId,
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: {
        sink: 'capability_health',
        category: 'env_failure',
        summary,
        confidence: 0.8,
      },
    });
  } catch (error) {
    logger.warn('Failed to enqueue Codex CLI failure review', error);
  }
}
