// ============================================================================
// Claude Code Agent Engine Adapter
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

const logger = createLogger('ClaudeCodeAdapter');

export interface ClaudeCodeRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  timeoutMs?: number;
  stallWarningMs?: number;
}

interface ClaudeParsedEvent {
  textDelta?: string;
  finalText?: string;
  toolName?: string;
  status?: string;
  error?: string;
  externalSessionId?: string;
}

export class ClaudeCodeAdapter {
  async run(request: ClaudeCodeRunRequest): Promise<AgentEngineRunResult> {
    if (request.attachmentsCount && request.attachmentsCount > 0) {
      throw new Error('Claude Code engine P1 only supports text prompts.');
    }

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get('claude_code');
    if (descriptor.installState !== 'installed' || !descriptor.binaryPath) {
      throw new Error(descriptor.lastError || 'Claude Code is not installed or not ready.');
    }

    const startedAt = Date.now();
    const runId = `claude_${startedAt}_${randomUUID().slice(0, 8)}`;
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getSessionManager();
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', 'claude-code');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const permissionProfile = assertReadOnlyExternalProfile(request.permissionProfile);
    const permissionMode = toClaudePermissionMode(permissionProfile);
    const commandSummary = [
      'claude -p',
      '--output-format stream-json',
      `--permission-mode ${permissionMode}`,
      '--allowedTools Read,Glob,Grep,LS',
      '<prompt:redacted>',
    ].join(' ');
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
        kind: 'claude_code',
        runId,
        logPath,
        cwd,
        permissionProfile,
        origin: 'manual',
        updatedAt: startedAt,
      }),
      updatedAt: startedAt,
    }, { allowEngineUpdate: true });

    const env = buildSafeEnv();
    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: request.sessionId,
      runId,
      source: 'agent_engine',
      title: 'Claude Code',
      summary: 'Claude Code engine run',
      command: commandSummary,
      cwd,
      status: 'running',
      startedAt,
      metadata: {
        engine: 'claude_code',
        permissionProfile,
        permissionMode,
        env: summarizeEnv(env),
        logPath,
        timeoutMs: timing.timeoutMs,
        stallWarningMs: timing.stallWarningMs,
      },
    });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.started',
      status: 'running',
      message: 'Claude Code run started',
      data: { runId, cwd, permissionProfile, permissionMode },
    });

    emitAgentEvent(request.sessionId, {
      type: 'turn_start',
      data: { turnId, iteration: 1 },
    });

    const args = buildClaudeCodeArgs(permissionProfile);
    const child = spawn(descriptor.binaryPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(request.prompt);

    let stdoutBuffer = '';
    let stderrText = '';
    let streamedText = '';
    let resultText = '';
    let externalSessionId: string | undefined;
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
        message: 'Claude Code produced output after a slow start',
      });
    };

    const stallTimer = setTimeout(() => {
      stalled = true;
      ledger.upsertTask({
        id: taskId,
        status: 'stalled',
        progress: {
          label: 'Claude Code slow start',
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.stalled',
        status: 'stalled',
        message: `Claude Code has not completed after ${Math.round(timing.stallWarningMs / 1000)}s`,
        data: { runId, logPath },
      });
    }, timing.stallWarningMs);

    const timeoutTimer = setTimeout(() => {
      timeoutMessage = `Claude Code timed out after ${Math.round(timing.timeoutMs / 1000)}s`;
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

    const handleJsonLine = (line: string) => {
      const parsed = parseClaudeCodeJsonLine(line);
      if (!parsed) return;
      if (parsed.externalSessionId) {
        externalSessionId = parsed.externalSessionId;
      }
      if (parsed.textDelta) {
        streamedText += parsed.textDelta;
        emitAgentEvent(request.sessionId, {
          type: 'message_delta',
          data: { role: 'assistant', path: 'content', text: parsed.textDelta, op: 'append', turnId },
        });
      }
      if (parsed.finalText) {
        resultText = parsed.finalText;
      }
      if (parsed.toolName) {
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.tool_call',
          status: 'running',
          message: parsed.toolName,
        });
      }
      if (parsed.status) {
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.status',
          status: 'running',
          message: parsed.status,
        });
      }
      if (parsed.error) {
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.error',
          status: 'running',
          message: parsed.error,
        });
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      markRunningAfterStall();
      const text = chunk.toString('utf8');
      logStream.write(text);
      stdoutBuffer += text;
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() ?? '';
      for (const line of parts) {
        handleJsonLine(line);
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
      handleJsonLine(stdoutBuffer);
    }

    await new Promise<void>((resolve) => logStream.end(resolve));

    const finalText = (resultText || streamedText).trim();
    if (finalText) {
      await fs.writeFile(lastMessagePath, finalText, 'utf8');
    }

    const completedAt = Date.now();
    const failed = Boolean(timeoutMessage || spawnErrorMessage || exitCode !== 0);

    ledger.addOutputRef({
      taskId,
      type: 'log',
      label: 'Claude Code log',
      path: logPath,
      mimeType: 'text/plain',
    });
    if (finalText) {
      ledger.addOutputRef({
        taskId,
        type: 'text',
        label: 'Claude Code final message',
        path: lastMessagePath,
        mimeType: 'text/markdown',
      });
    }

    const sessionEngine = normalizeAgentEngineSession({
      kind: 'claude_code',
      runId,
      externalSessionId,
      logPath,
      cwd,
      permissionProfile,
      origin: 'manual',
      updatedAt: completedAt,
    });

    if (failed) {
      const message = timeoutMessage || spawnErrorMessage || stderrText.trim() || `Claude Code exited with code ${exitCode}`;
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
        title: 'Claude Code failed',
        message,
        payload: { runId, logPath },
      });
      enqueueFailureReview(request.sessionId, message);
      emitAgentEvent(request.sessionId, {
        type: 'error',
        data: { message, code: 'CLAUDE_CODE_FAILED', details: { runId, logPath, exitCode } },
      });
      await sessionManager.updateSession(request.sessionId, {
        status: 'error',
        engine: sessionEngine,
        updatedAt: completedAt,
      }, { allowEngineUpdate: true });
      emitAgentEvent(request.sessionId, { type: 'agent_complete', data: null });
      return {
        runId,
        sessionId: request.sessionId,
        engine: 'claude_code',
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
      content: finalText || 'Claude Code completed without text output.',
      timestamp: completedAt,
      metadata: {
        workbench: {
          workingDirectory: cwd,
        },
      },
    };
    await sessionManager.addMessageToSession(request.sessionId, assistantMessage);

    emitAgentEvent(request.sessionId, {
      type: 'message',
      data: assistantMessage,
    });
    emitAgentEvent(request.sessionId, {
      type: 'turn_end',
      data: { turnId },
    });
    emitAgentEvent(request.sessionId, {
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
      message: 'Claude Code run completed',
      data: { runId, logPath, externalSessionId },
    });
    ledger.queueNotification({
      taskId,
      sessionId: request.sessionId,
      type: 'task_completed',
      title: 'Claude Code completed',
      message: 'Claude Code run completed',
      payload: { runId, logPath },
    });

    await sessionManager.updateSession(request.sessionId, {
      status: 'idle',
      engine: sessionEngine,
      updatedAt: completedAt,
    }, { allowEngineUpdate: true });

    return {
      runId,
      sessionId: request.sessionId,
      engine: 'claude_code',
      status: 'completed',
      outputText: assistantMessage.content,
      logPath,
      exitCode,
    };
  }
}

export function buildClaudeCodeArgs(profile: AgentEnginePermissionProfile = 'read_only'): string[] {
  const permissionMode = toClaudePermissionMode(profile);
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--permission-mode',
    permissionMode,
    '--allowedTools',
    'Read,Glob,Grep,LS',
    '--no-chrome',
    '--strict-mcp-config',
    '--include-partial-messages',
    '--no-session-persistence',
  ];
}

export function toClaudePermissionMode(_profile: AgentEnginePermissionProfile): 'plan' {
  return 'plan';
}

export function parseClaudeCodeJsonLine(line: string): ClaudeParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  return extractClaudeEvent(event as Record<string, unknown>);
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const allowExact = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'CLAUDE_CONFIG_DIR',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (allowExact.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
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

function extractClaudeEvent(event: Record<string, unknown>): ClaudeParsedEvent {
  const type = firstString(event.type);
  const subtype = firstString(event.subtype);
  const message = isRecord(event.message) ? event.message : undefined;
  const delta = isRecord(event.delta) ? event.delta : undefined;
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(event.content) ? event.content : undefined;
  const textDelta = firstString(
    event.text,
    delta?.text,
    extractContentText(content),
    typeof message?.content === 'string' ? message.content : undefined,
  );
  const finalText = type === 'result'
    ? firstString(event.result, event.text, extractContentText(content))
    : undefined;
  const toolName = firstString(event.name, extractToolName(content));
  const status = statusFromClaudeEvent(type, subtype, event);
  const error = firstString(event.error, isRecord(event.error) ? event.error.message : undefined);
  const externalSessionId = firstString(event.session_id, event.sessionId, message?.session_id, message?.sessionId);

  return {
    ...(textDelta && type !== 'result' ? { textDelta } : {}),
    ...(finalText ? { finalText } : {}),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(externalSessionId ? { externalSessionId } : {}),
  };
}

function statusFromClaudeEvent(
  type: string | undefined,
  subtype: string | undefined,
  event: Record<string, unknown>,
): string | undefined {
  if (!type) return undefined;
  if (type === 'system' && subtype === 'init') return 'Claude Code initialized';
  if (type === 'result') return subtype ? `Claude Code result: ${subtype}` : 'Claude Code result';
  return firstString(event.status);
}

function extractContentText(content?: unknown[]): string | undefined {
  if (!content) return undefined;
  const text = content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'text') return firstString(part.text, part.content) || '';
      if (part.type === 'content_block_delta' && isRecord(part.delta)) return firstString(part.delta.text) || '';
      return '';
    })
    .join('');
  return text || undefined;
}

function extractToolName(content?: unknown[]): string | undefined {
  if (!content) return undefined;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const name = firstString(part.name, isRecord(part.input) ? part.input.name : undefined);
    if (part.type === 'tool_use' && name) return name;
  }
  return undefined;
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

function emitAgentEvent(sessionId: string, event: AgentEventEnvelope): void {
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
    logger.warn('Failed to enqueue Claude Code failure review', error);
  }
}
