// ============================================================================
// ACP (Agent Client Protocol) Client Adapter
// ============================================================================
//
// Neo 作为 **ACP client** 驱动外部 agent。与 7 家 CLI adapter 的根本差别：
//
//   CLI 系：一次性 `-p "<prompt>"` 进程，Neo 解析 stdout 的文本事件流，
//           工具在对方进程里执行，Neo 看不见也拦不住 ⇒ 只能 read_only。
//   ACP：   长连接 JSON-RPC 会话，事件已是结构化状态机（不需要文本解析）；
//           **副作用全部反向委托回 Neo**（fs/* 与 terminal/*），
//           所以写权限可以放开——闸门在 acpClientHostBridge，不在对方的自觉。
//
// 全部形态取自 2026-08-27 对 Kimi Code CLI 0.38.0 的真机抓包：
//   code-agent-private-archive/docs/evidence/2026-08-27-N-ACP-CLIENT-事件流映射表.md
//
// 🔴 两个 SDK 坑（各实付撞过一次）：
//   1. ctx 上只有 buildSession / attachSession / request / notify，**没有** initialize()
//      / newSession()（.d.ts 里便捷方法已标 deprecated）⇒ 一律走 ctx.request(method, params)。
//   2. handler 收的是**上下文对象** `{ params, signal, agent, requestId }`，不是 params 本身。
//      照直觉写 `(p) => p.path` 全拿到 undefined，且对 ctx 做 JSON.stringify 会抛
//      "Converting circular structure to JSON"，回给对方一个 -32603，看起来像对方工具坏了。
//
// 🔴 resume 走 `session/load` 不走 `session/resume`：两者实测都通，但 load 回放完整历史
//    （9 条 vs 1 条）且 load 后可直接续发 prompt。判据是协议标准位 agentCapabilities.loadSession，
//    不是 Kimi 的扩展位 sessionCapabilities.resume。CLI 系的 externalEngineResumeBuilders
//    是 argv 形状（args: string[]），对 ACP 不适用，故本适配器不复用它。

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Readable, Writable, PassThrough } from 'stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { getLogsPath } from '../../platform';
import type { AgentEventEnvelope, Message, MessageMetadata } from '../../../shared/contract';
import type {
  AgentEngineRunRequest,
  AgentEngineRunResult,
  ExternalAgentEngineKind,
  ExternalEnginePermissionAsk,
} from '../../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getShellPath } from '../infra/shellEnvironment';
import { createLogger } from '../infra/logger';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { getAgentEngineRegistry } from './agentEngineRegistry';
import {
  assertAgentEngineCapability,
  assertExternalEngineProfile,
  assertExternalSubagentProfile,
  assertWorkspaceCwd,
} from './agentEngineGuards';
import { normalizeCodexCliRunTiming } from './agentEngineTiming';
import { buildAgentEngineModelDecision } from './agentEngineModelDecision';
import { classifyAgentEngineFailure, formatAgentEngineFailureContent } from './agentEngineFailureDiagnostics';
import { assertExternalRuntimeAttachments } from '../../model/providerRuntimeCapabilities';
import type { ExternalEngineDurableLifecycle } from './externalEngineDurableLifecycle';
import { emitExternalAgentEvent } from './agentEngineEventSink';
import { bindExternalEngineAbort } from './agentEngineAbort';
import { getAgentEngineSessionSink } from './agentEngineSessionSink';
import { AcpClientHostBridge } from './acpClientHostBridge';
import { AcpToolCallTracker, mapAcpSessionUpdate } from './acpEventMapping';

const logger = createLogger('AcpClientAdapter');

const ACP_PROTOCOL_VERSION = 1;
const EMPTY_RESPONSE_MESSAGE = 'The ACP engine returned an empty response.';

interface AcpClientRunRequest extends AgentEngineRunRequest {
  workspaceRoot: string;
  attachmentsCount?: number;
  messageMetadata?: MessageMetadata;
  emitEvent?: (event: AgentEventEnvelope) => void;
  timeoutMs?: number;
  stallWarningMs?: number;
  durableLifecycle?: ExternalEngineDurableLifecycle;
  /**
   * 已持久化的 ACP sessionId。有值走 session/load 续接上一轮上下文，无值 session/new。
   * 🔴 这条对 ACP 是必需而非可选：每次 run 都是新起的 agent 进程，不 load 就丢全部历史
   *（CLI 系不受影响，因为 Neo 每轮都把上下文重新塞进 prompt）。
   */
  externalSessionId?: string;
  /** Neo 现有审批链。缺省则所有副作用 fail-closed 一律拒。 */
  requestPermission?: ExternalEnginePermissionAsk;
}

interface AcpEngineConfig {
  kind: ExternalAgentEngineKind;
  label: string;
  /** 进入 ACP 模式的子命令，例如 kimi 的 `acp`。 */
  acpArgs: string[];
  errorCode: string;
  logSlug: string;
  runPrefix: string;
}

class AcpClientAdapter {
  constructor(private readonly config: AcpEngineConfig) {}

  async run(request: AcpClientRunRequest): Promise<AgentEngineRunResult> {
    const { config } = this;
    assertExternalRuntimeAttachments(config.kind, request.attachmentsCount, config.label);

    const cwd = assertWorkspaceCwd(request.cwd, request.workspaceRoot);
    const registry = getAgentEngineRegistry();
    const descriptor = await registry.get(config.kind);
    if (descriptor.installState !== 'installed' || !descriptor.binaryPath) {
      throw new Error(descriptor.lastError || `${config.label} is not installed or not ready.`);
    }
    assertAgentEngineCapability(
      config.kind,
      descriptor.capabilities,
      request.externalSessionId ? 'resume' : 'execute',
    );

    const permissionProfile = request.executionOrigin === 'subagent'
      ? assertExternalSubagentProfile(request.permissionProfile, { origin: 'subagent', cwd })
      : assertExternalEngineProfile(config.kind, request.permissionProfile);
    const model = request.model?.trim();
    const startedAt = Date.now();
    const runId = request.durableLifecycle?.runId ?? `${config.runPrefix}_${startedAt}_${randomUUID().slice(0, 8)}`;
    const taskId = `agent-engine:${runId}`;
    const turnId = generateMessageId();
    const sessionManager = getAgentEngineSessionSink(request.executionOrigin);
    const ledger = getBackgroundTaskLedger();
    const logDir = path.join(getLogsPath(), 'agent-engines', config.logSlug);
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);
    const lastMessagePath = path.join(logDir, `${runId}.last.md`);
    const logStream = createWriteStream(logPath, { flags: 'a' });
    // 🔴 WriteStream 的 'error' 必须有人接。Node 对没有监听者的 'error' 事件的处理是
    // 升级成 uncaught exception —— 在 webServer 里那等于**整个服务端进程被打死**，
    // 一次外部引擎运行就能让 app 失联（2026-08-27 真机实付，见证据档）。
    logStream.on('error', (error) => logger.warn('[ACP] 引擎日志写入失败', { runId, error }));

    const commandSummary = [
      path.basename(descriptor.binaryPath),
      ...config.acpArgs,
      '<acp:session/prompt>',
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
        kind: config.kind,
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

    const env = buildSafeEnv();
    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: request.sessionId,
      runId,
      source: 'agent_engine',
      title: config.label,
      summary: `${config.label} ACP run`,
      command: commandSummary,
      cwd,
      status: 'running',
      startedAt,
      metadata: {
        engine: config.kind,
        transport: 'acp',
        ...(model ? { model } : {}),
        permissionProfile,
        logPath,
        timeoutMs: timing.timeoutMs,
        stallWarningMs: timing.stallWarningMs,
      },
    });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.started',
      status: 'running',
      message: `${config.label} ACP run started`,
      data: { runId, cwd, permissionProfile, model, resumed: Boolean(request.externalSessionId) },
    });

    const emit = (event: AgentEventEnvelope) => emitExternalAgentEvent(request.sessionId, event, request.emitEvent);
    emit({ type: 'turn_start', data: { turnId, iteration: 1 } });

    const child = spawn(descriptor.binaryPath, config.acpArgs, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const unbindAbort = bindExternalEngineAbort(request.abortSignal, () => {
      if (request.durableLifecycle) void request.durableLifecycle.terminateProcess('SIGTERM');
      else child.kill('SIGTERM');
    });
    await request.durableLifecycle?.attachProcess(child, {
      binary: descriptor.binaryPath,
      version: descriptor.version,
      commandSummary,
      logPath,
      model,
      permissionProfile,
    });

    // stdout 一路进 SDK 解析、一路进日志；不要让 SDK 独占，否则日志里什么都没有。
    const stdoutTap = new PassThrough();
    stdoutTap.on('error', (error) => logger.warn('[ACP] stdout tap 出错', { runId, error }));
    // 🔴 收尾开始后一律不再写这两个流：kill 之后子进程 stdout 里的缓冲数据还会继续到达，
    // 写进已 end 的流就是 ERR_STREAM_WRITE_AFTER_END。
    let tornDown = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (tornDown) return;
      request.durableLifecycle?.observeStdout(chunk.byteLength);
      logStream.write(chunk);
      stdoutTap.write(chunk);
    });
    child.stdout.on('end', () => { if (!tornDown) stdoutTap.end(); });
    let stderrText = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (tornDown) return;
      request.durableLifecycle?.observeStderr(chunk.byteLength);
      const text = chunk.toString('utf8');
      stderrText += text;
      logStream.write(text);
    });

    /**
     * 关子进程再收日志流，**顺序不能反**。
     * 先摘监听器堵住新数据，再等进程真的 close（CLI 系 adapter 天然是这个顺序，
     * 因为它们 await 'close' 之后才收尾；本适配器是主动 kill，必须自己等）。
     */
    const shutdownChild = async (): Promise<void> => {
      tornDown = true;
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => { child.once('close', () => resolve()); }),
          new Promise<void>((resolve) => { setTimeout(resolve, 2_000).unref?.(); }),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      if (!stdoutTap.writableEnded) stdoutTap.end();
      await new Promise<void>((resolve) => logStream.end(resolve));
    };
    let spawnErrorMessage: string | undefined;
    child.on('error', (error) => { spawnErrorMessage = error.message; });

    const bridge = new AcpClientHostBridge({
      workspaceRoot: request.workspaceRoot,
      cwd,
      sessionId: request.sessionId,
      ...(request.requestPermission ? { requestPermission: request.requestPermission } : {}),
      onDenied: (what, detail) => {
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.status',
          status: 'running',
          message: `denied ${what} (${detail})`,
        });
      },
      onAllowed: (what, tool) => {
        ledger.appendEvent({
          taskId,
          type: 'agent_engine.tool_call',
          status: 'running',
          message: `${tool} — approved ${what}`,
        });
      },
    });

    let streamedText = '';
    let externalSessionId = request.externalSessionId;
    let acpErrorText = '';
    let timeoutMessage: string | undefined;
    let stopReason: string | undefined;
    const tracker = new AcpToolCallTracker();

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
    }, timing.timeoutMs);
    const stallTimer = setTimeout(() => {
      ledger.appendEvent({
        taskId,
        type: 'agent_engine.stalled',
        status: 'stalled',
        message: `${config.label} has not completed after ${Math.round(timing.stallWarningMs / 1000)}s`,
        data: { runId, logPath },
      });
    }, timing.stallWarningMs);

    const app = client({ name: 'neo' })
      // 🔴 handler 收的是 context 对象，params 在 ctx.params 上（SDK 坑 2）。
      .onNotification('session/update', async (ctx) => {
        const mapped = mapAcpSessionUpdate((ctx.params as { update?: unknown } | undefined)?.update);
        if (!mapped) {
          logger.warn('[ACP] 收到无法识别的 session/update', { runId });
          return;
        }
        switch (mapped.kind) {
          case 'text':
            request.durableLifecycle?.observeNormalizedEvent('text_delta');
            streamedText += mapped.text;
            emit({
              type: 'message_delta',
              data: { role: 'assistant', path: 'content', text: mapped.text, op: 'append', turnId },
            });
            break;
          case 'reasoning':
            request.durableLifecycle?.observeNormalizedEvent('text_delta');
            emit({
              type: 'message_delta',
              data: { role: 'assistant', path: 'reasoning', text: mapped.text, op: 'append', turnId },
            });
            break;
          case 'tool_call': {
            const label = tracker.observe(mapped);
            request.durableLifecycle?.observeNormalizedEvent('tool_call', label);
            // 中间的 in_progress 有几十条（抓包实测 39 条），只在首见与终态落台账，别刷屏。
            if (mapped.status === 'pending' || AcpToolCallTracker.isTerminal(mapped.status)) {
              ledger.appendEvent({
                taskId,
                type: 'agent_engine.tool_call',
                status: mapped.status === 'failed' ? 'failed' : 'running',
                message: `${label} — ${mapped.status ?? 'update'}`,
              });
            }
            break;
          }
          case 'usage':
            if (typeof mapped.used === 'number') {
              ledger.appendEvent({
                taskId,
                type: 'agent_engine.status',
                status: 'running',
                message: `context ${mapped.used}/${mapped.size ?? '?'}`,
              });
            }
            break;
          case 'ignored':
            // 认得但本刀不消费。**不静默**：漏消费和协议异常必须在日志里分得开。
            logger.debug?.('[ACP] 未消费的 session/update', { sessionUpdate: mapped.sessionUpdate });
            break;
        }
      })
      .onRequest('session/request_permission', async (ctx) => bridge.requestToolPermission(ctx.params as never))
      .onRequest('fs/read_text_file', async (ctx) => bridge.readTextFile(ctx.params as never))
      .onRequest('fs/write_text_file', async (ctx) => bridge.writeTextFile(ctx.params as never))
      .onRequest('terminal/create', async (ctx) => bridge.createTerminal(ctx.params as never))
      .onRequest('terminal/output', async (ctx) => bridge.terminalOutput((ctx.params as { terminalId: string }).terminalId))
      .onRequest('terminal/wait_for_exit', async (ctx) => bridge.waitForTerminalExit((ctx.params as { terminalId: string }).terminalId))
      .onRequest('terminal/kill', async (ctx) => bridge.killTerminal((ctx.params as { terminalId: string }).terminalId))
      .onRequest('terminal/release', async (ctx) => bridge.releaseTerminal((ctx.params as { terminalId: string }).terminalId));

    try {
      await app.connectWith(
        // Node 的 web-stream 类型与 lib.dom 的 ReadableStream<Uint8Array> 在 BYOB reader
        // 泛型上不兼容，运行时是同一个对象；SDK 只按 NDJSON 读写，故此处收窄为它要的类型。
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(stdoutTap) as unknown as ReadableStream<Uint8Array>,
        ),
        async (ctx) => {
          await ctx.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            // 全部声明为 true：真正的闸在 acpClientHostBridge 的逐次审批上，
            // 而不是在这里把能力藏起来。藏能力换不来安全，只换来对方报「能力不可用」。
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
            clientInfo: { name: 'neo', version: '1.0.0' },
          });

          if (externalSessionId) {
            // 续接：session/load 会把历史以 session/update 回放一遍（含 user_message_chunk，
            // 已在 mapAcpSessionUpdate 里按 ignored 拦掉，不会渲染成助手输出）。
            await ctx.request('session/load', { sessionId: externalSessionId, cwd, mcpServers: [] });
            ledger.appendEvent({
              taskId,
              type: 'agent_engine.resumed',
              status: 'running',
              message: `${config.label} resumed via ACP session/load`,
              data: { externalSessionId },
            });
          } else {
            const created = await ctx.request('session/new', { cwd, mcpServers: [] }) as {
              sessionId: string;
              configOptions?: AcpConfigOption[];
            };
            externalSessionId = created.sessionId;
            request.durableLifecycle?.persistExternalSessionId(created.sessionId);
            const modelSelection = await applyModelSelection(ctx, created.sessionId, created.configOptions, model);
            if (!modelSelection.applied && modelSelection.reason) {
              // 如实降级：不假装设置成功，也不静默——用户在 UI 上选了模型，
              // 结果跑的是 agent 默认模型，这件事必须能在台账里查到。
              ledger.appendEvent({
                taskId,
                type: 'agent_engine.status',
                status: 'running',
                message: `model not applied, using agent default (${modelSelection.reason})`,
              });
            }
          }

          const response = await ctx.request('session/prompt', {
            sessionId: externalSessionId,
            prompt: [{ type: 'text', text: request.prompt }],
          }) as { stopReason?: string };
          stopReason = response?.stopReason;
        },
      );
    } catch (error) {
      acpErrorText = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeoutTimer);
      clearTimeout(stallTimer);
      unbindAbort();
      bridge.disposeAll();
      await shutdownChild();
    }

    const finalText = streamedText.trim();
    if (finalText) await fs.writeFile(lastMessagePath, finalText, 'utf8');

    const completedAt = Date.now();
    const emptyResponse = !finalText && !acpErrorText && !timeoutMessage && !spawnErrorMessage;
    const failed = Boolean(timeoutMessage || spawnErrorMessage || acpErrorText || emptyResponse);

    ledger.addOutputRef({ taskId, type: 'log', label: `${config.label} log`, path: logPath, mimeType: 'text/plain' });
    if (finalText) {
      ledger.addOutputRef({ taskId, type: 'text', label: `${config.label} final message`, path: lastMessagePath, mimeType: 'text/markdown' });
    }

    const sessionEngine = normalizeAgentEngineSession({
      kind: config.kind,
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
        || acpErrorText
        || (emptyResponse ? EMPTY_RESPONSE_MESSAGE : '')
        || stderrText.trim()
        || `${config.label} ACP run failed`;
      const failureDiagnostics = classifyAgentEngineFailure({
        engine: config.kind,
        message,
        occurredAt: completedAt,
        timeout: Boolean(timeoutMessage),
        spawnError: Boolean(spawnErrorMessage),
      });
      ledger.upsertTask({
        id: taskId,
        status: 'failed',
        completedAt,
        durationMs: completedAt - startedAt,
        failure: { message, category: 'agent_engine', reason: failureDiagnostics.reason },
      });
      ledger.appendEvent({ taskId, type: 'agent_engine.failed', status: 'failed', message, data: { logPath, failure: failureDiagnostics } });
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
        data: { message, code: config.errorCode, suggestion: failureDiagnostics.suggestion, details: { runId, logPath, failure: failureDiagnostics } },
      });
      const assistantMessage: Message = {
        id: turnId,
        role: 'assistant',
        content: formatAgentEngineFailureContent(descriptor.label, failureDiagnostics, logPath),
        timestamp: completedAt,
        modelDecision: buildAgentEngineModelDecision(descriptor, model, completedAt, failureDiagnostics),
        metadata: { workbench: { workingDirectory: cwd } },
      };
      await sessionManager.addMessageToSession(request.sessionId, assistantMessage);
      emit({ type: 'message', data: assistantMessage });
      emit({ type: 'turn_end', data: { turnId } });
      await sessionManager.updateSession(request.sessionId, {
        status: 'error',
        engine: normalizeAgentEngineSession({ ...sessionEngine, failure: failureDiagnostics, updatedAt: completedAt }),
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
        error: message,
        failure: failureDiagnostics,
      };
      await request.durableLifecycle?.finish(result, true);
      return result;
    }

    const assistantMessage: Message = {
      id: turnId,
      role: 'assistant',
      content: finalText,
      timestamp: completedAt,
      modelDecision: buildAgentEngineModelDecision(descriptor, model, completedAt),
      metadata: { workbench: { workingDirectory: cwd } },
    };
    await sessionManager.addMessageToSession(request.sessionId, assistantMessage);
    emit({ type: 'message', data: assistantMessage });
    emit({ type: 'turn_end', data: { turnId } });
    emit({ type: 'agent_complete', data: null });

    ledger.upsertTask({ id: taskId, status: 'completed', completedAt, durationMs: completedAt - startedAt });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.completed',
      status: 'completed',
      message: `${config.label} ACP run completed`,
      data: { runId, logPath, externalSessionId, stopReason },
    });
    ledger.queueNotification({
      taskId,
      sessionId: request.sessionId,
      type: 'task_completed',
      title: `${config.label} completed`,
      message: `${config.label} ACP run completed`,
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
    };
    await request.durableLifecycle?.finish(result, Boolean(finalText));
    return result;
  }
}

/** Kimi Code 的 ACP 形态：`kimi acp`。凭据仍归官方 CLI（KIMI_CODE_HOME）。 */
export class KimiAcpAdapter extends AcpClientAdapter {
  constructor() {
    super({
      kind: 'kimi_code_acp',
      label: 'Kimi Code (ACP)',
      acpArgs: ['acp'],
      errorCode: 'KIMI_CODE_ACP_FAILED',
      logSlug: 'kimi-code-acp',
      runPrefix: 'kimi_acp',
    });
  }
}

interface AcpConfigOption {
  id?: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value?: string }>;
}

/**
 * 把 Neo 选定的模型经 ACP 规范的 `session/set_config_option` 落到会话上。
 *
 * 🔴 不接这一步就是「装好没接电」：Neo 的模型选择器照常显示、用户照常选，
 * agent 却一直跑自己的默认模型。2026-08-27 真机撞到时两边碰巧都是 kimi-code/k3，
 * 症状被掩盖成一个 401——正因为看不出来，才必须显式接上并在没接上时留痕。
 *
 * 选不到就**如实降级**：返回原因交给调用方落台账，不假装设置成功。
 */
async function applyModelSelection(
  ctx: { request: (method: string, params: unknown) => Promise<unknown> },
  sessionId: string,
  configOptions: AcpConfigOption[] | undefined,
  model: string | undefined,
): Promise<{ applied: boolean; reason?: string }> {
  if (!model) return { applied: false };
  // 按 category 找，不按 id 猜：category 是协议规定的语义位，id 由各家自取。
  const modelOption = configOptions?.find((option) => option.category === 'model');
  if (!modelOption?.id) return { applied: false, reason: 'agent exposes no model config option' };
  if (modelOption.currentValue === model) return { applied: true };
  const offered = (modelOption.options ?? []).map((option) => option.value).filter(Boolean);
  if (!offered.includes(model)) {
    return { applied: false, reason: `agent does not offer ${model}; offers ${offered.join(', ')}` };
  }
  await ctx.request('session/set_config_option', { sessionId, configId: modelOption.id, value: model });
  return { applied: true };
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'KIMI_CODE_HOME']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (allowed.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) env[key] = value;
  }
  env.PATH = getShellPath();
  return env;
}
