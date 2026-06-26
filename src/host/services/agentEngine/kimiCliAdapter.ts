// ============================================================================
// Kimi Code CLI Agent Engine Adapter
// ============================================================================
//
// 对照 codex/claude adapter，按 §8 已核实事实建造：
//   - spawn `kimi -p "<prompt>" --output-format stream-json`，prompt 必须作为
//     命令行参数（没有 --print、不能走 stdin 管道、没有 kimi run）；模型用 `-m <id>`
//   - stdout 每行一个 JSON（JSONL），逐行 parse；正文在 stdout，thinking/进度在 stderr，
//     只读 stdout 即得正文。tool_calls 消息先于对应 Tool 消息
//   - 凭据大坑：Kimi CLI **不从 env var 读 API key**（KIMI_API_KEY 等无效）。靠预先
//     `kimi login` 落盘 或 KIMI_CODE_HOME 指向的 config.toml。为每个会话/用户设
//     KIMI_CODE_HOME 隔离凭据目录（request.kimiCodeHome 可注入，默认沿用 env / CLI 默认）
//   - 容错：OpenAI 兼容后端偶发流式完成但空响应，报 `empty response`，要 catch 不崩
//
// registry.get('kimi_code') 的 descriptor 由 agentEngineRegistry.detectKimi 探活产出；
// model catalog 在 BUILTIN_AGENT_ENGINE_MODEL_CATALOG 登记 kimi_code 引擎条目。

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AppWindow, getLogsPath } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { AgentEventEnvelope, Message, MessageMetadata } from '../../../shared/contract';
import type {
  AgentEngineRunRequest,
  AgentEngineRunResult,
} from '../../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { getShellPath } from '../infra/shellEnvironment';
import { getBackgroundTaskLedger } from '../../tasks/backgroundTaskLedger';
import { getAgentEngineRegistry } from './agentEngineRegistry';
import { assertReadOnlyExternalProfile, assertWorkspaceCwd } from './agentEngineGuards';
import { normalizeCodexCliRunTiming } from './agentEngineTiming';
import { buildAgentEngineModelDecision } from './agentEngineModelDecision';
import { classifyAgentEngineFailure, formatAgentEngineFailureContent } from './agentEngineFailureDiagnostics';

const logger = createLogger('KimiCliAdapter');

const EMPTY_RESPONSE_MESSAGE = 'Kimi Code returned an empty response.';

export interface KimiCliRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  emitEvent?: (event: AgentEventEnvelope) => void;
  timeoutMs?: number;
  stallWarningMs?: number;
  /**
   * 每会话/用户隔离的 Kimi 凭据目录（KIMI_CODE_HOME）。CLI 不读 env API key，凭据
   * 走此目录下 `kimi login` 落盘 或 config.toml。不传则沿用 env.KIMI_CODE_HOME /
   * CLI 默认 ~/.kimi-code。per-user 自动派生留给地基②（detection/凭据隔离接口）。
   */
  kimiCodeHome?: string;
}

interface KimiParsedEvent {
  textDelta?: string;
  finalText?: string;
  toolName?: string;
  status?: string;
  error?: string;
  statusCode?: number;
  externalSessionId?: string;
}

export class KimiCliAdapter {
  async run(request: KimiCliRunRequest): Promise<AgentEngineRunResult> {
    if (request.attachmentsCount && request.attachmentsCount > 0) {
      throw new Error('Kimi Code engine only supports text prompts.');
    }

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get('kimi_code');
    if (!descriptor.executable || descriptor.installState !== 'installed') {
      throw new Error(descriptor.lastError || 'Kimi Code CLI is not installed or not ready.');
    }

    const permissionProfile = assertReadOnlyExternalProfile(request.permissionProfile);
    const model = request.model?.trim();
    const startedAt = Date.now();
    const runId = `kimi_${startedAt}_${randomUUID().slice(0, 8)}`;
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getSessionManager();
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', 'kimi-code');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const commandSummary = [
      'kimi -p',
      '--output-format stream-json',
      ...(model ? [`-m ${model}`] : []),
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
        kind: 'kimi_code',
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

    const env = buildSafeEnv(request.kimiCodeHome);
    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: request.sessionId,
      runId,
      source: 'agent_engine',
      title: 'Kimi Code',
      summary: 'Kimi Code engine run',
      command: commandSummary,
      cwd,
      status: 'running',
      startedAt,
      metadata: {
        engine: 'kimi_code',
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
      message: 'Kimi Code run started',
      data: { runId, cwd, permissionProfile, model },
    });

    const emit = (event: AgentEventEnvelope) => emitAgentEvent(request.sessionId, event, request.emitEvent);

    emit({
      type: 'turn_start',
      data: { turnId, iteration: 1 },
    });

    const args = buildKimiArgs(request.prompt, model);
    // stdin: 'ignore' —— Kimi 不走 stdin 管道，prompt 已作为命令行参数。
    const child = spawn(descriptor.binaryPath || 'kimi', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrText = '';
    let streamedText = '';
    let resultText = '';
    let cliErrorText = '';
    let cliErrorStatusCode: number | undefined;
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
        message: 'Kimi Code produced output after a slow start',
      });
    };

    const stallTimer = setTimeout(() => {
      stalled = true;
      ledger.upsertTask({
        id: taskId,
        status: 'stalled',
        progress: {
          label: 'Kimi Code slow start',
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.stalled',
        status: 'stalled',
        message: `Kimi Code has not completed after ${Math.round(timing.stallWarningMs / 1000)}s`,
        data: { runId, logPath },
      });
    }, timing.stallWarningMs);

    const timeoutTimer = setTimeout(() => {
      timeoutMessage = `Kimi Code timed out after ${Math.round(timing.timeoutMs / 1000)}s`;
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
      const parsed = parseKimiJsonLine(line);
      if (!parsed) return;
      if (parsed.externalSessionId) {
        externalSessionId = parsed.externalSessionId;
      }
      if (parsed.textDelta) {
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

    // 正文只读 stdout（thinking/进度走 stderr，不丢正文）
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
    // 容错：OpenAI 兼容后端偶发流式完成（exit 0）但空响应。CLI 退出码正常但既无正文
    // 也无 CLI error 时，按 empty response 归一成可识别失败，不让它静默成空白回复。
    const emptyResponse = !finalText && !cliErrorText && !timeoutMessage && !spawnErrorMessage && exitCode === 0;
    const failed = Boolean(timeoutMessage || spawnErrorMessage || exitCode !== 0 || emptyResponse);

    ledger.addOutputRef({
      taskId,
      type: 'log',
      label: 'Kimi Code log',
      path: logPath,
      mimeType: 'text/plain',
    });
    if (finalText) {
      ledger.addOutputRef({
        taskId,
        type: 'text',
        label: 'Kimi Code final message',
        path: lastMessagePath,
        mimeType: 'text/markdown',
      });
    }

    const sessionEngine = normalizeAgentEngineSession({
      kind: 'kimi_code',
      model,
      runId,
      externalSessionId,
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
        || `Kimi Code exited with code ${exitCode}`;
      const failureDiagnostics = classifyAgentEngineFailure({
        engine: 'kimi_code',
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
        title: 'Kimi Code failed',
        message,
        payload: { runId, logPath, failure: failureDiagnostics },
      });
      emit({
        type: 'error',
        data: { message, code: 'KIMI_CODE_FAILED', suggestion: failureDiagnostics.suggestion, details: { runId, logPath, exitCode, failure: failureDiagnostics } },
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
      return {
        runId,
        sessionId: request.sessionId,
        engine: 'kimi_code',
        status: 'failed',
        outputText: finalText,
        logPath,
        exitCode,
        error: message,
        failure: failureDiagnostics,
      };
    }

    const assistantMessage: Message = {
      id: turnId,
      role: 'assistant',
      content: finalText || 'Kimi Code completed without text output.',
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
      message: 'Kimi Code run completed',
      data: { runId, logPath, externalSessionId },
    });
    ledger.queueNotification({
      taskId,
      sessionId: request.sessionId,
      type: 'task_completed',
      title: 'Kimi Code completed',
      message: 'Kimi Code run completed',
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
      engine: 'kimi_code',
      status: 'completed',
      outputText: assistantMessage.content,
      logPath,
      exitCode,
    };
  }
}

export function buildKimiArgs(prompt: string, model?: string | null): string[] {
  // -p == --prompt（headless）；prompt 必须作为命令行参数，不能走 stdin。
  // --output-format stream-json 仅配 -p；-m <id> 选模型。
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    ...(model?.trim() ? ['-m', model.trim()] : []),
  ];
}

export function parseKimiJsonLine(line: string): KimiParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  return extractKimiEvent(event as Record<string, unknown>);
}

function buildSafeEnv(kimiCodeHome?: string): NodeJS.ProcessEnv {
  // Kimi CLI **不从 env var 读 API key**（KIMI_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY
  // 都不读），所以这里不注入任何 key——剥离一切 KEY/TOKEN/SECRET。凭据走 KIMI_CODE_HOME
  // 下的 `kimi login` 落盘 / config.toml；request.kimiCodeHome 可为每会话隔离一套目录，
  // 不传则沿用 env.KIMI_CODE_HOME / CLI 默认 ~/.kimi-code。
  const allowExact = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'KIMI_CODE_HOME',
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
  if (kimiCodeHome?.trim()) {
    env.KIMI_CODE_HOME = kimiCodeHome.trim();
  }
  // PATH 用 login shell 捕获的完整 PATH（与 registry 探测同源），否则打包 app 下
  // kimi 的 node shebang 找不到 node（同 codexCliAdapter）。
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

function extractKimiEvent(event: Record<string, unknown>): KimiParsedEvent {
  const outerType = firstString(event.type);
  const inner = isRecord(event.event) ? event.event : undefined;
  const payload = inner ?? event;
  const type = firstString(payload.type, outerType);
  const subtype = firstString(payload.subtype, event.subtype);
  const lowerType = (type ?? '').toLowerCase();
  const message = isRecord(payload.message) ? payload.message : isRecord(event.message) ? event.message : undefined;
  const delta = isRecord(payload.delta) ? payload.delta : isRecord(event.delta) ? event.delta : undefined;
  const contentBlock = isRecord(payload.content_block) ? payload.content_block : undefined;
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(payload.content)
      ? payload.content
      : Array.isArray(event.content)
        ? event.content
        : undefined;

  const isResult = type === 'result' || outerType === 'result' || lowerType.includes('final');

  const textDelta = !isResult
    ? firstString(
        typeof payload.text === 'string' ? payload.text : undefined,
        typeof event.text === 'string' ? event.text : undefined,
        delta?.text,
        contentBlock?.type === 'text' ? contentBlock.text : undefined,
        extractContentText(content),
        typeof message?.content === 'string' ? message.content : undefined,
      )
    : undefined;

  const finalText = isResult
    ? firstString(payload.result, event.result, payload.text, event.text, extractContentText(content))
    : undefined;

  const toolName = firstString(payload.name, contentBlock?.name, extractToolName(content));
  const status = statusFromKimiEvent(type, subtype, payload);
  const statusCode = firstNumber(
    payload.api_error_status,
    event.api_error_status,
    payload.statusCode,
    event.statusCode,
    isRecord(payload.error) ? payload.error.status : undefined,
    isRecord(payload.error) ? payload.error.statusCode : undefined,
  );
  const error = firstString(
    typeof payload.error === 'string' ? payload.error : undefined,
    isRecord(payload.error) ? payload.error.message : undefined,
    payload.is_error === true ? finalText : undefined,
  );
  const externalSessionId = firstString(
    event.session_id,
    event.sessionId,
    payload.session_id,
    payload.sessionId,
    message?.session_id,
    message?.sessionId,
  );

  return {
    ...(textDelta ? { textDelta } : {}),
    ...(finalText ? { finalText } : {}),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(externalSessionId ? { externalSessionId } : {}),
  };
}

function statusFromKimiEvent(
  type: string | undefined,
  subtype: string | undefined,
  event: Record<string, unknown>,
): string | undefined {
  if (!type) return undefined;
  if (type === 'system' && subtype === 'init') return 'Kimi Code initialized';
  if (type === 'result') return subtype ? `Kimi Code result: ${subtype}` : 'Kimi Code result';
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
    if ((part.type === 'tool_use' || part.type === 'tool_call') && name) return name;
  }
  return undefined;
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
