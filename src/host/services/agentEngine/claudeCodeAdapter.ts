// ============================================================================
// Claude Code Agent Engine Adapter
// ============================================================================

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { AppWindow, getLogsPath } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { AgentEventEnvelope, Message, MessageMetadata } from '../../../shared/contract';
import type {
  AgentEnginePermissionProfile,
  AgentEngineRunRequest,
  AgentEngineRunResult,
  ExternalAgentEngineKind,
} from '../../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../infra/sessionManager';
import { getShellEnvironmentValue, getShellPath } from '../infra/shellEnvironment';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { getAgentEngineRegistry } from './agentEngineRegistry';
import { assertReadOnlyExternalProfile, assertWorkspaceCwd } from './agentEngineGuards';
import { normalizeCodexCliRunTiming } from './agentEngineTiming';
import { buildAgentEngineModelDecision } from './agentEngineModelDecision';
import { classifyAgentEngineFailure, formatAgentEngineFailureContent } from './agentEngineFailureDiagnostics';
import { assertExternalRuntimeAttachments } from '../../model/providerRuntimeCapabilities';
import { extractExternalModelUsage, type ExternalEngineDurableLifecycle } from './externalEngineDurableLifecycle';
import type { ExternalEngineResumeLaunch } from './externalEngineResumeBuilders';
import {
  assertExternalForkContextDispatchLifecycle,
  composeExternalForkLaunchPrompt,
  summarizeExternalForkContextHandoff,
  type ExternalForkContextDispatchCallback,
  type ExternalForkContextHandoff,
} from '../sessionFork/context';

export interface ClaudeProtocolCliConfig {
  kind: Extract<ExternalAgentEngineKind, 'claude_code' | 'codebuddy_code' | 'grok_cli'>;
  label: string;
  runPrefix: string;
  logSlug: string;
  errorCode: string;
  promptTransport: 'stdin' | 'argv';
  buildArgs(profile: AgentEnginePermissionProfile, model?: string | null, prompt?: string): string[];
  buildEnv(): NodeJS.ProcessEnv;
  commandSummary(model?: string): string;
  parseJsonLine?(line: string, label: string): ClaudeParsedEvent | null;
}

const CLAUDE_CODE_CONFIG: ClaudeProtocolCliConfig = {
  kind: 'claude_code',
  label: 'Claude Code',
  runPrefix: 'claude',
  logSlug: 'claude-code',
  errorCode: 'CLAUDE_CODE_FAILED',
  promptTransport: 'stdin',
  buildArgs: buildClaudeCodeArgs,
  buildEnv: buildSafeEnv,
  commandSummary: (model) => [
    'claude -p',
    '--verbose',
    ...(model ? [`--model ${model}`] : []),
    '--output-format stream-json',
    '--input-format text',
    '--permission-mode plan',
    '--safe-mode',
    '--disable-slash-commands',
    '--tools Read,Glob,Grep,LS',
    '--allowedTools Read,Glob,Grep,LS',
    '--strict-mcp-config',
    '--include-partial-messages',
    '<prompt:redacted>',
  ].join(' '),
};

export interface ClaudeCodeRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  emitEvent?: (event: AgentEventEnvelope) => void;
  timeoutMs?: number;
  stallWarningMs?: number;
  durableLifecycle?: ExternalEngineDurableLifecycle;
  resumeLaunch?: ExternalEngineResumeLaunch;
  /**
   * Audited fork prefix for the first child run. This starts a new Claude
   * provider session and may never be combined with --resume.
   */
  forkContextHandoff?: ExternalForkContextHandoff;
  onForkContextDispatchStart?: ExternalForkContextDispatchCallback;
  onForkContextDispatched?: ExternalForkContextDispatchCallback;
}

export interface ClaudeParsedEvent {
  textDelta?: string;
  textDeltaSource?: 'stream' | 'snapshot';
  finalText?: string;
  toolName?: string;
  status?: string;
  error?: string;
  statusCode?: number;
  externalSessionId?: string;
}

export class ClaudeCodeAdapter {
  constructor(private readonly config: ClaudeProtocolCliConfig = CLAUDE_CODE_CONFIG) {}

  async run(request: ClaudeCodeRunRequest): Promise<AgentEngineRunResult> {
    const { config } = this;
    assertExternalRuntimeAttachments(config.kind, request.attachmentsCount, config.label);
    if (config.kind !== 'claude_code' && (request.resumeLaunch || request.forkContextHandoff)) {
      throw new Error(`${config.label} continuation and fork context are not verified.`);
    }
    const launchPrompt = request.forkContextHandoff
      ? composeExternalForkLaunchPrompt({
          engine: config.kind,
          handoff: request.forkContextHandoff,
          prompt: request.prompt,
          resumeLaunchPresent: Boolean(request.resumeLaunch),
        })
      : request.prompt;
    const forkContextAudit = request.forkContextHandoff
      ? summarizeExternalForkContextHandoff(request.forkContextHandoff)
      : undefined;
    assertExternalForkContextDispatchLifecycle(
      request.forkContextHandoff,
      request.onForkContextDispatchStart,
      request.onForkContextDispatched,
    );

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get(config.kind);
    if (descriptor.installState !== 'installed' || !descriptor.binaryPath) {
      throw new Error(descriptor.lastError || `${config.label} is not installed or not ready.`);
    }

    const permissionProfile = assertReadOnlyExternalProfile(request.permissionProfile);
    const permissionMode = toClaudePermissionMode(permissionProfile);
    const model = request.model?.trim();
    const startedAt = Date.now();
    const runId = request.durableLifecycle?.runId ?? `${config.runPrefix}_${startedAt}_${randomUUID().slice(0, 8)}`;
    assertResumeLaunchBinding(request.resumeLaunch, request.durableLifecycle, runId, request.sessionId, cwd);
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getSessionManager();
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', config.logSlug);
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const commandSummary = request.resumeLaunch?.commandSummary ?? config.commandSummary(model);
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
        kind: config.kind,
        model,
        runId,
        externalSessionId: request.resumeLaunch?.externalSessionId,
        logPath,
        cwd,
        permissionProfile,
        origin: 'manual',
        updatedAt: startedAt,
      }),
      updatedAt: startedAt,
    }, { allowEngineUpdate: true });

    const env = config.buildEnv();
    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: request.sessionId,
      runId,
      source: 'agent_engine',
      title: config.label,
      summary: `${config.label} engine run`,
      command: commandSummary,
      cwd,
      status: 'running',
      startedAt,
      metadata: {
        engine: config.kind,
        ...(model ? { model } : {}),
        permissionProfile,
        permissionMode,
        env: summarizeEnv(env),
        logPath,
        timeoutMs: timing.timeoutMs,
        stallWarningMs: timing.stallWarningMs,
        ...(forkContextAudit ? { forkContext: forkContextAudit } : {}),
      },
    });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.started',
      status: 'running',
      message: `${config.label} run started`,
      data: { runId, cwd, permissionProfile, permissionMode, model },
    });

    const emit = (event: AgentEventEnvelope) => emitAgentEvent(request.sessionId, event, request.emitEvent);

    emit({
      type: 'turn_start',
      data: { turnId, iteration: 1 },
    });

    const args = request.resumeLaunch?.args
      ?? config.buildArgs(permissionProfile, model, config.promptTransport === 'argv' ? launchPrompt : undefined);
    const child = spawn(descriptor.binaryPath, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: [config.promptTransport === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error(`${config.label} did not expose the required output streams.`);
    }
    await request.durableLifecycle?.attachProcess(child, {
      binary: descriptor.binaryPath,
      version: descriptor.version,
      commandSummary,
      logPath,
      model,
      permissionProfile,
    });
    const onForkContextDispatchStart = request.onForkContextDispatchStart;
    const onForkContextDispatched = request.onForkContextDispatched;
    try {
      if (config.promptTransport === 'argv') {
        // Prompt is already present in the redacted argv shape built above.
      } else if (forkContextAudit) {
        if (!onForkContextDispatchStart || !onForkContextDispatched) {
          throw new Error('Fork context dispatch lifecycle disappeared after validation');
        }
        await onForkContextDispatchStart(forkContextAudit);
        if (!child.stdin) throw new Error(`${config.label} did not expose stdin.`);
        child.stdin.end(launchPrompt);
      } else {
        if (!child.stdin) throw new Error(`${config.label} did not expose stdin.`);
        child.stdin.end(request.resumeLaunch?.stdin ?? (request.resumeLaunch ? undefined : launchPrompt));
      }
    } catch (error) {
      logStream.end();
      try {
        if (request.durableLifecycle) await request.durableLifecycle.terminateProcess('SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // Preserve the dispatch lifecycle failure that left the durable state fail-closed.
      }
      throw error;
    }

    let stdoutBuffer = '';
    let stderrText = '';
    let streamedText = '';
    let resultText = '';
    let cliErrorText = '';
    let cliErrorStatusCode: number | undefined;
    let observedExternalSessionId: string | undefined;
    let confirmedExternalSessionId: string | undefined;
    let spawnErrorMessage: string | undefined;
    let timeoutMessage: string | undefined;
    let resumeIdentityError: string | undefined;
    let stalled = false;

    const markRunningAfterStall = () => {
      if (!stalled || timeoutMessage) return;
      stalled = false;
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.resumed',
        status: 'running',
        message: `${config.label} produced output after a slow start`,
      });
    };

    const stallTimer = setTimeout(() => {
      stalled = true;
      ledger.upsertTask({
        id: taskId,
        status: 'stalled',
        progress: {
          label: `${config.label} slow start`,
        },
      });
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.stalled',
        status: 'stalled',
        message: `${config.label} has not completed after ${Math.round(timing.stallWarningMs / 1000)}s`,
        data: { runId, logPath },
      });
    }, timing.stallWarningMs);

    const timeoutTimer = setTimeout(() => {
      timeoutMessage = `${config.label} timed out after ${Math.round(timing.timeoutMs / 1000)}s`;
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
      const parsed = config.parseJsonLine?.(line, config.label)
        ?? parseClaudeProtocolJsonLine(line, config.label);
      if (!parsed) return;
      const usage = extractExternalModelUsage(line);
      if (usage) request.durableLifecycle?.observeModelUsage(usage.inputTokens, usage.outputTokens);
      if (parsed.externalSessionId) {
        observedExternalSessionId = parsed.externalSessionId;
        if (request.resumeLaunch && parsed.externalSessionId !== request.resumeLaunch.externalSessionId) {
          resumeIdentityError = 'Claude resumed a different external session';
          void request.durableLifecycle?.terminateProcess('SIGTERM');
        } else {
          confirmedExternalSessionId = parsed.externalSessionId;
        }
      }
      if (parsed.textDelta && (parsed.textDeltaSource !== 'snapshot' || streamedText.length === 0)) {
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

    stdout.on('data', (chunk: Buffer) => {
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

    stderr.on('data', (chunk: Buffer) => {
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
    if (request.resumeLaunch && !observedExternalSessionId && !resumeIdentityError) {
      resumeIdentityError = 'Claude resume did not confirm the external session identity';
    }
    if (request.forkContextHandoff && !confirmedExternalSessionId && !resumeIdentityError) {
      resumeIdentityError = 'Claude fork handoff did not confirm a new external session identity';
    }
    const emptyResponse = !finalText && !cliErrorText && !timeoutMessage && !spawnErrorMessage && exitCode === 0;
    const failed = Boolean(timeoutMessage || spawnErrorMessage || resumeIdentityError || exitCode !== 0 || emptyResponse);
    const sessionExternalSessionId = failed
      ? request.resumeLaunch?.externalSessionId
      : confirmedExternalSessionId ?? request.resumeLaunch?.externalSessionId;
    if (forkContextAudit && !failed) {
      if (!onForkContextDispatched) {
        throw new Error('Fork context dispatch lifecycle disappeared after provider identity confirmation');
      }
      try {
        await onForkContextDispatched(forkContextAudit);
      } catch (error) {
        try {
          if (request.durableLifecycle) await request.durableLifecycle.terminateProcess('SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          // Preserve the consumed-state persistence failure and leave the handoff fail-closed.
        }
        throw error;
      }
    }
    if (!failed && sessionExternalSessionId) {
      request.durableLifecycle?.persistExternalSessionId(sessionExternalSessionId);
    }

    ledger.addOutputRef({
      taskId,
      type: 'log',
      label: `${config.label} log`,
      path: logPath,
      mimeType: 'text/plain',
    });
    if (finalText) {
      ledger.addOutputRef({
        taskId,
        type: 'text',
        label: `${config.label} final message`,
        path: lastMessagePath,
        mimeType: 'text/markdown',
      });
    }

    const sessionEngine = normalizeAgentEngineSession({
      kind: config.kind,
      model,
      runId,
      externalSessionId: sessionExternalSessionId,
      logPath,
      cwd,
      permissionProfile,
      origin: 'manual',
      updatedAt: completedAt,
    });

    if (failed) {
      const message = timeoutMessage
        || spawnErrorMessage
        || resumeIdentityError
        || cliErrorText
        || (emptyResponse ? `${config.label} returned an empty response.` : '')
        || stderrText.trim()
        || finalText
        || `${config.label} exited with code ${exitCode}`;
      const failureDiagnostics = classifyAgentEngineFailure({
        engine: config.kind,
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
        title: `${config.label} failed`,
        message,
        payload: { runId, logPath, failure: failureDiagnostics },
      });
      emit({
        type: 'error',
        data: { message, code: config.errorCode, suggestion: failureDiagnostics.suggestion, details: { runId, logPath, exitCode, failure: failureDiagnostics } },
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
        engine: config.kind,
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
      content: finalText || `${config.label} completed without text output.`,
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
      message: `${config.label} run completed`,
      data: { runId, logPath, externalSessionId: sessionExternalSessionId },
    });
    ledger.queueNotification({
      taskId,
      sessionId: request.sessionId,
      type: 'task_completed',
      title: `${config.label} completed`,
      message: `${config.label} run completed`,
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
      engine: config.kind,
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
  if (!lifecycle) throw new Error('Claude resume requires a durable recovery lifecycle');
  if (launch.runId !== runId || launch.sessionId !== sessionId || launch.cwd !== cwd) {
    throw new Error('Claude resume launch has a stale logical run, session, or cwd binding');
  }
  if (launch.attempt !== lifecycle.attempt || launch.ownerEpoch !== lifecycle.ownerEpoch) {
    throw new Error('Claude resume launch has a stale attempt or owner epoch');
  }
}

export function buildClaudeCodeArgs(
  profile: AgentEnginePermissionProfile = 'read_only',
  model?: string | null,
): string[] {
  const permissionMode = toClaudePermissionMode(profile);
  return [
    '-p',
    '--verbose',
    ...(model?.trim() ? ['--model', model.trim()] : []),
    '--safe-mode',
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--permission-mode',
    permissionMode,
    '--tools',
    'Read,Glob,Grep,LS',
    '--allowedTools',
    'Read,Glob,Grep,LS',
    '--no-chrome',
    '--strict-mcp-config',
    '--include-partial-messages',
  ];
}

export function toClaudePermissionMode(_profile: AgentEnginePermissionProfile): 'plan' {
  return 'plan';
}

export function parseClaudeCodeJsonLine(line: string): ClaudeParsedEvent | null {
  return parseClaudeProtocolJsonLine(line, 'Claude Code');
}

export function parseClaudeProtocolJsonLine(
  line: string,
  label: string,
): ClaudeParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  return extractClaudeEvent(event as Record<string, unknown>, label);
}

const ANTHROPIC_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_PROFILE',
]);

const CLAUDE_AUTH_ENV_KEYS = new Set([
  'CCR_OAUTH_TOKEN_FILE',
  'CLAUDE_AI_INFERENCE_SCOPE',
  'CLAUDE_AI_OAUTH_SCOPES',
  'CLAUDE_AI_PROFILE_SCOPE',
  'CLAUDE_CODE_ACCOUNT_TAGGED_ID',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
  'CLAUDE_CODE_HFI_BEARER_TOKEN',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_LOCAL_OAUTH_API_BASE',
  'CLAUDE_LOCAL_OAUTH_APPS_BASE',
  'CLAUDE_LOCAL_OAUTH_CONSOLE_BASE',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_TRUSTED_DEVICE_TOKEN',
]);

const CLAUDE_AUTH_SHELL_ENV_KEYS = new Set([
  ...ANTHROPIC_AUTH_ENV_KEYS,
  ...CLAUDE_AUTH_ENV_KEYS,
  'CLAUDE_CONFIG_DIR',
]);

function isClaudeAuthEnvKey(key: string): boolean {
  return key.startsWith('ANTHROPIC_')
    || key.startsWith('CLAUDE_CODE_OAUTH_')
    || key.startsWith('CLAUDE_AI_')
    || CLAUDE_AUTH_ENV_KEYS.has(key);
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
    if (allowExact.has(key) || isClaudeAuthEnvKey(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value;
    }
  }
  for (const key of CLAUDE_AUTH_SHELL_ENV_KEYS) {
    if (env[key]) continue;
    const value = getShellEnvironmentValue(key);
    if (value) env[key] = value;
  }
  if (!env.HOME) {
    const home = homedir();
    if (home) env.HOME = home;
  }
  // PATH 用 login shell 捕获的完整 PATH（与 registry 探测同源），否则打包 app 下
  // claude 的 node shebang 找不到 node（同 codexCliAdapter）。
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

function extractClaudeEvent(
  event: Record<string, unknown>,
  label: string,
): ClaudeParsedEvent {
  const outerType = firstString(event.type);
  const inner = isRecord(event.event) ? event.event : undefined;
  const payload = inner ?? event;
  const type = firstString(payload.type, outerType);
  const subtype = firstString(payload.subtype, event.subtype);
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
  const textDelta = firstString(
    payload.text,
    event.text,
    delta?.text,
    contentBlock?.type === 'text' ? contentBlock.text : undefined,
    extractContentText(content),
    typeof message?.content === 'string' ? message.content : undefined,
  );
  const textDeltaSource = outerType === 'stream_event' ? 'stream' : type === 'assistant' ? 'snapshot' : undefined;
  const finalText = type === 'result' || outerType === 'result'
    ? firstString(payload.result, event.result, payload.text, event.text, extractContentText(content))
    : undefined;
  const toolName = firstString(payload.name, contentBlock?.name, extractToolName(content));
  const status = statusFromClaudeEvent(type, subtype, payload, label);
  const statusCode = firstNumber(
    payload.api_error_status,
    event.api_error_status,
    payload.statusCode,
    event.statusCode,
    isRecord(payload.error) ? payload.error.status : undefined,
    isRecord(payload.error) ? payload.error.statusCode : undefined,
  );
  const error = firstString(
    payload.error,
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
    ...(textDelta && type !== 'result' && outerType !== 'result' ? { textDelta } : {}),
    ...(textDeltaSource ? { textDeltaSource } : {}),
    ...(finalText ? { finalText } : {}),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(externalSessionId ? { externalSessionId } : {}),
  };
}

function statusFromClaudeEvent(
  type: string | undefined,
  subtype: string | undefined,
  event: Record<string, unknown>,
  label: string,
): string | undefined {
  if (!type) return undefined;
  if (type === 'system' && subtype === 'init') return `${label} initialized`;
  if (type === 'result') return subtype ? `${label} result: ${subtype}` : `${label} result`;
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
