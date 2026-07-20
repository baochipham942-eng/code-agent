// ============================================================================
// MiMo-Code CLI Agent Engine Adapter
// ============================================================================
//
// 对照 codexCliAdapter：spawn `mimo run "<prompt>" --format json`，逐行解析 JSON
// 事件流，归一成内部 AgentEvent。凭据沿用 external engine 的 buildSafeEnv 思路
// （只透传 HOME/PATH/MIMO_HOME 等白名单，剥离敏感 KEY/TOKEN）——MiMo 的 OAuth
// 落盘 / `tp-` 订阅 key 由 CLI 自己读 MIMO_HOME 下的凭据，适配器不自创注入路径。
//
// registry.get('mimo_code') 的 descriptor 由 agentEngineRegistry.detectMimo 探活产出；
// model catalog 在 BUILTIN_AGENT_ENGINE_MODEL_CATALOG 登记 mimo_code 引擎条目。

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
import {
  MIMO_CODE_PERMISSION_ENV,
  MIMO_CODE_READ_ONLY_PERMISSION,
} from '../../../shared/constants';
import { getSessionManager } from '../infra/sessionManager';
import { getShellPath } from '../infra/shellEnvironment';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { getAgentEngineRegistry } from './agentEngineRegistry';
import { assertReadOnlyExternalProfile, assertWorkspaceCwd } from './agentEngineGuards';
import { normalizeCodexCliRunTiming } from './agentEngineTiming';
import { buildAgentEngineModelDecision } from './agentEngineModelDecision';
import { classifyAgentEngineFailure, formatAgentEngineFailureContent } from './agentEngineFailureDiagnostics';
import { assertExternalRuntimeAttachments } from '../../model/providerRuntimeCapabilities';
import { extractExternalModelUsage, type ExternalEngineDurableLifecycle } from './externalEngineDurableLifecycle';

// 容错：OpenAI 兼容后端偶发流式完成（exit 0）但空响应。与 Kimi 对称，按 empty response
// 归一成可识别失败，不让它静默落到「completed without text output」兜底文案。
const EMPTY_RESPONSE_MESSAGE = 'MiMo-Code returned an empty response.';

export interface MimoCliRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  emitEvent?: (event: AgentEventEnvelope) => void;
  timeoutMs?: number;
  stallWarningMs?: number;
  durableLifecycle?: ExternalEngineDurableLifecycle;
}

interface MimoParsedEvent {
  textDelta?: string;
  finalText?: string;
  toolName?: string;
  status?: string;
  error?: string;
  statusCode?: number;
}

export class MimoCliAdapter {
  async run(request: MimoCliRunRequest): Promise<AgentEngineRunResult> {
    assertExternalRuntimeAttachments('mimo_code', request.attachmentsCount, 'MiMo-Code');

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get('mimo_code');
    if (!descriptor.executable || descriptor.installState !== 'installed') {
      throw new Error(descriptor.lastError || 'MiMo-Code CLI is not installed or not ready.');
    }

    const permissionProfile = assertReadOnlyExternalProfile(request.permissionProfile);
    const model = request.model?.trim();
    const startedAt = Date.now();
    const runId = request.durableLifecycle?.runId ?? `mimo_${startedAt}_${randomUUID().slice(0, 8)}`;
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getSessionManager();
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', 'mimo-code');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const commandSummary = [
      'mimo run',
      '--format json',
      ...(model ? [`--model ${model}`] : []),
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
        kind: 'mimo_code',
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

    const env = buildSafeEnv(permissionProfile);
    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: request.sessionId,
      runId,
      source: 'agent_engine',
      title: 'MiMo-Code',
      summary: 'MiMo-Code engine run',
      command: commandSummary,
      cwd,
      status: 'running',
      startedAt,
      metadata: {
        engine: 'mimo_code',
        ...(model ? { model } : {}),
        permissionProfile,
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
      message: 'MiMo-Code run started',
      data: { runId, cwd, permissionProfile, model },
    });

    const emit = (event: AgentEventEnvelope) => emitAgentEvent(request.sessionId, event, request.emitEvent);

    emit({
      type: 'turn_start',
      data: { turnId, iteration: 1 },
    });

    const args = buildMimoArgs(request.prompt, model);
    const child = spawn(descriptor.binaryPath || 'mimo', args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await request.durableLifecycle?.attachProcess(child, {
      binary: descriptor.binaryPath || 'mimo',
      version: descriptor.version,
      commandSummary,
      logPath,
      model,
      permissionProfile,
    });

    let stdoutBuffer = '';
    let stderrText = '';
    let streamedText = '';
    let resultText = '';
    let cliErrorText = '';
    let cliErrorStatusCode: number | undefined;
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
        message: 'MiMo-Code produced output after a slow start',
      });
    };

    const stallTimer = setTimeout(() => {
      stalled = true;
      ledger.upsertTask({
        id: taskId,
        status: 'stalled',
        progress: {
          label: 'MiMo-Code slow start',
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.stalled',
        status: 'stalled',
        message: `MiMo-Code has not completed after ${Math.round(timing.stallWarningMs / 1000)}s`,
        data: { runId, logPath },
      });
    }, timing.stallWarningMs);

    const timeoutTimer = setTimeout(() => {
      timeoutMessage = `MiMo-Code timed out after ${Math.round(timing.timeoutMs / 1000)}s`;
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

    const handleJsonLine = (line: string) => {
      const parsed = parseMimoJsonLine(line);
      if (!parsed) return;
      const usage = extractExternalModelUsage(line);
      if (usage) request.durableLifecycle?.observeModelUsage(usage.inputTokens, usage.outputTokens);
      if (parsed.textDelta) {
        request.durableLifecycle?.observeNormalizedEvent('text_delta');
        streamedText += parsed.textDelta;
        emit({
          type: 'message_delta',
          data: { role: 'assistant', path: 'content', text: parsed.textDelta, op: 'append', turnId },
        });
      }
      if (parsed.finalText) {
        resultText = parsed.finalText;
      }
      if (parsed.toolName) {
        request.durableLifecycle?.observeNormalizedEvent('tool_call', parsed.toolName);
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.tool_call',
          status: 'running',
          message: parsed.toolName,
        });
      }
      if (parsed.status) {
        request.durableLifecycle?.observeNormalizedEvent('status', parsed.status);
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.status',
          status: 'running',
          message: parsed.status,
        });
      }
      if (parsed.error) {
        cliErrorText = parsed.error;
        if (typeof parsed.statusCode === 'number') {
          cliErrorStatusCode = parsed.statusCode;
        }
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
      request.durableLifecycle?.observeStdout(chunk.byteLength);
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
      request.durableLifecycle?.observeStderr(chunk.byteLength);
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
    // CLI 退出码正常（exit 0）但既无正文也无 CLI error 时，按 empty response 归一成失败。
    const emptyResponse = !finalText && !cliErrorText && !timeoutMessage && !spawnErrorMessage && exitCode === 0;
    const failed = Boolean(timeoutMessage || spawnErrorMessage || exitCode !== 0 || emptyResponse);

    ledger.addOutputRef({
      taskId,
      type: 'log',
      label: 'MiMo-Code log',
      path: logPath,
      mimeType: 'text/plain',
    });
    if (finalText) {
      ledger.addOutputRef({
        taskId,
        type: 'text',
        label: 'MiMo-Code final message',
        path: lastMessagePath,
        mimeType: 'text/markdown',
      });
    }

    const sessionEngine = normalizeAgentEngineSession({
      kind: 'mimo_code',
      model,
      runId,
      logPath,
      cwd,
      permissionProfile,
      origin: 'manual',
      updatedAt: completedAt,
    });

    if (failed) {
      const message = timeoutMessage
        || spawnErrorMessage
        || cliErrorText
        || (emptyResponse ? EMPTY_RESPONSE_MESSAGE : '')
        || stderrText.trim()
        || finalText
        || `MiMo-Code exited with code ${exitCode}`;
      const failureDiagnostics = classifyAgentEngineFailure({
        engine: 'mimo_code',
        message,
        exitCode,
        statusCode: cliErrorStatusCode,
        occurredAt: completedAt,
        timeout: Boolean(timeoutMessage),
        spawnError: Boolean(spawnErrorMessage),
      });
      const failedSessionEngine = normalizeAgentEngineSession({
        ...sessionEngine,
        failure: failureDiagnostics,
        updatedAt: completedAt,
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
        title: 'MiMo-Code failed',
        message,
        payload: { runId, logPath, failure: failureDiagnostics },
      });
      emit({
        type: 'error',
        data: { message, code: 'MIMO_CODE_FAILED', suggestion: failureDiagnostics.suggestion, details: { runId, logPath, exitCode, failure: failureDiagnostics } },
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
        engine: failedSessionEngine,
        updatedAt: completedAt,
      }, { allowEngineUpdate: true });
      emit({ type: 'agent_complete', data: null });
      const result: AgentEngineRunResult = {
        runId,
        sessionId: request.sessionId,
        engine: 'mimo_code',
        status: 'failed',
        outputText: finalText,
        logPath,
        exitCode,
        error: message,
        failure: failureDiagnostics,
      };
      await request.durableLifecycle?.finish(result, true);
      return result;
    }

    const assistantMessage: Message = {
      id: turnId,
      role: 'assistant',
      content: finalText || 'MiMo-Code completed without text output.',
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
      message: 'MiMo-Code run completed',
      data: { runId, logPath },
    });
    ledger.queueNotification({
      taskId,
      sessionId: request.sessionId,
      type: 'task_completed',
      title: 'MiMo-Code completed',
      message: 'MiMo-Code run completed',
      payload: { runId, logPath },
    });

    await sessionManager.updateSession(request.sessionId, {
      status: 'idle',
      engine: sessionEngine,
      updatedAt: completedAt,
    }, { allowEngineUpdate: true });

    const result: AgentEngineRunResult = {
      runId,
      sessionId: request.sessionId,
      engine: 'mimo_code',
      status: 'completed',
      outputText: assistantMessage.content,
      logPath,
      exitCode,
    };
    await request.durableLifecycle?.finish(result, Boolean(finalText));
    return result;
  }
}

export function buildMimoArgs(prompt: string, model?: string | null): string[] {
  return [
    'run',
    prompt,
    '--format',
    'json',
    ...(model?.trim() ? ['--model', model.trim()] : []),
  ];
}

export function parseMimoJsonLine(line: string): MimoParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  return extractMimoEvent(event as Record<string, unknown>);
}

function buildSafeEnv(permissionProfile: AgentEnginePermissionProfile): NodeJS.ProcessEnv {
  // 与 codex/claude 同款白名单：只透传无害系统变量 + MIMO 自家凭据目录（MIMO_HOME），
  // 剥离一切 KEY/TOKEN/SECRET，避免把 shell 里的敏感凭据带进子进程。MiMo 的 OAuth /
  // tp- 订阅 key 由 CLI 读 MIMO_HOME 落盘文件，不靠 env var 注入。
  // 注意：MIMOCODE_PERMISSION 不在白名单——剥掉用户 shell 里可能存在的策略，由本函数
  // 末尾按 profile 注入权威只读策略，保证非 TTY 下不弹交互审批（见 mimoCode.ts 注释）。
  const allowExact = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'MIMO_HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (allowExact.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value;
    }
  }
  // PATH 用 login shell 捕获的完整 PATH（与 registry 探测同源），否则打包 app 下
  // mimo 的 node shebang 找不到 node（同 codexCliAdapter）。
  env.PATH = getShellPath();
  // 按 permissionProfile 注入 MiMo 权限策略。本仓库当前只允许 read_only（见
  // assertReadOnlyExternalProfile），故注入只读策略：catch-all deny + 只读工具 allow，
  // 任何工具都不解析成 ask → `mimo run` 非交互不阻塞（descriptor 声明的 read_only 真正生效）。
  if (permissionProfile === 'read_only') {
    env[MIMO_CODE_PERMISSION_ENV] = JSON.stringify(MIMO_CODE_READ_ONLY_PERMISSION);
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

function extractMimoEvent(event: Record<string, unknown>): MimoParsedEvent {
  const type = firstString(event.type, event.event);
  const msg = isRecord(event.msg) ? event.msg : undefined;
  const data = isRecord(event.data) ? event.data : isRecord(msg?.data) ? msg.data : undefined;
  const item = isRecord(event.item) ? event.item : isRecord(msg?.item) ? msg.item : undefined;
  const delta = isRecord(event.delta) ? event.delta : isRecord(data?.delta) ? data.delta : undefined;

  const lowerType = (type ?? '').toLowerCase();
  const isResult = lowerType.includes('result') || lowerType.includes('final') || lowerType.includes('complete');

  const rawText = firstString(
    typeof event.delta === 'string' ? event.delta : undefined,
    delta?.text,
    event.text,
    data?.text,
    data?.delta,
    msg?.text,
    extractMessageText(item),
    extractMessageText(msg),
  );

  const textDelta = rawText && !isResult && isTextLikeType(lowerType, event, msg) ? rawText : undefined;
  const finalText = isResult
    ? firstString(event.result, data?.result, rawText)
    : undefined;

  const toolName = firstString(
    data?.name,
    msg?.name,
    item?.name,
    isRecord(item?.function) ? item.function.name : undefined,
  );

  const error = firstString(
    typeof event.error === 'string' ? event.error : undefined,
    isRecord(event.error) ? event.error.message : undefined,
    data?.error,
    event.is_error === true ? rawText : undefined,
  );
  const statusCode = firstNumber(
    event.status_code,
    event.statusCode,
    isRecord(event.error) ? event.error.status : undefined,
    isRecord(event.error) ? event.error.statusCode : undefined,
    data?.status_code,
  );

  return {
    ...(textDelta ? { textDelta } : {}),
    ...(finalText ? { finalText } : {}),
    ...(toolName && isToolLikeType(lowerType, item, msg) ? { toolName } : {}),
    ...(lowerType.includes('status') ? { status: firstString(data?.status, msg?.status, type) } : {}),
    ...(error ? { error } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
  };
}

function isTextLikeType(type: string, event: Record<string, unknown>, msg?: Record<string, unknown>): boolean {
  const joined = [type, event.role, msg?.role]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return joined.includes('assistant')
    || joined.includes('message')
    || joined.includes('text')
    || joined.includes('delta')
    || joined.includes('response')
    || joined.includes('content');
}

function isToolLikeType(type: string, item?: Record<string, unknown>, msg?: Record<string, unknown>): boolean {
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

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
