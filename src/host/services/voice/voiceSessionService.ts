// ============================================================================
// VoiceSessionService —— Phase 0 最小实现
//
// 职责：全局单路互斥、生命周期、Renderer WS ↔ 上游 transport 的内存中继。
// 媒体面：Renderer 二进制帧 = PCM16@16k 单声道上行；Host 二进制帧 = PCM16@24k 下行。
//         控制/事件面走同一条 WS 的文本帧（JSON）。音频帧不落盘、不进日志。
// ============================================================================

import type { WebSocket as WsSocket } from 'ws';
import { QWEN_OMNI_REALTIME_MODEL, VOICE_SESSION_MAX_DURATION_MS, VOICE_TEARDOWN_DRAIN_MS } from '../../../shared/constants/voice';
import type { VoiceClientCommand, VoiceEvent, VoiceTransportHandle } from '../../../shared/contract/voice';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { getConfigService } from '../core/configService';
import { getSessionManager } from '../infra/sessionManager';
import { getPermissionModeManager } from '../../permissions/modes';
import { qwenOmniTransport } from './qwenOmniTransport';
import { resolveVoiceRouting } from './voiceRouting';
import { beginVoiceDispatch, endVoiceDispatch } from './voiceAgentCoordinator';
import { recordVoiceCall } from './voiceUsageLedger';
import { VOICE_TOOL_DEFINITIONS, executeVoiceTool } from './voiceTools';
import type { VoiceLiveSettings } from '../../../shared/contract/settings';

const logger = createLogger('VoiceSession');

/** 读设置页「实时通话」组；读不到一律 undefined（= 全部走默认），绝不让设置读写炸掉通话。 */
function readVoiceLiveSettings(): VoiceLiveSettings | undefined {
  try {
    return getConfigService().getSettings().voice?.live;
  } catch {
    return undefined;
  }
}

/**
 * 语言偏好走 instructions 而不是上游参数：DashScope 的 input_audio_transcription
 * 语言参数本批未真机验证，不赌；在短人设后追加一句对话语言约束是验证过的路径。
 */
function withLanguageDirective(instructions: string, language: VoiceLiveSettings['language']): string {
  if (language === 'zh') return `${instructions}\n请始终用中文与用户对话。`;
  if (language === 'en') return `${instructions}\nAlways converse with the user in English.`;
  return instructions;
}

interface ActiveSession {
  id: string;
  neoSessionId: string;
  startedAt: number;
  client: WsSocket;
  upstream: VoiceTransportHandle;
  maxDurationTimer: NodeJS.Timeout;
  /** 本次通话派出去的任务数，进通话摘要 */
  workItemCount: number;
  /** 助手字幕的增量缓冲：上游只给 delta，挂断时若 done 没到要拿它冲成 final。 */
  transcriptBuf: { assistant: string };
}

// ponytail: 单进程内一个模块级变量就是「全局单路」的全部实现（方案 §2.6）。
// 多进程/多窗口场景真出现时再抬到共享状态。
let active: ActiveSession | null = null;
// 建上游连接是 await，闸门必须在 await 之前就合上：只看 active 的话，两路并发拨号
// 会同时通过检查、各建一条上游连接（都在计费，其中一条永远无人释放）。
let connecting = false;
let sessionSeq = 0;

export function getActiveVoiceSessionId(): string | null {
  return active?.id ?? null;
}

function send(client: WsSocket, event: VoiceEvent): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

/**
 * final 字幕落到绑定会话的消息流。走 sessionManager 既有写入路径，不新造存储。
 * 只落文本，不落音频（方案 §8.1）。
 */
async function persistTranscript(neoSessionId: string, role: 'user' | 'assistant', text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    await getSessionManager().addMessageToSession(neoSessionId, {
      id: `voice-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content: trimmed,
      timestamp: Date.now(),
      metadata: { source: 'voice' },
    });
  } catch (err) {
    logger.warn('failed to persist transcript', { role, message: err instanceof Error ? err.message : 'unknown' });
  }
}

async function teardown(reason: string): Promise<void> {
  const session = active;
  if (!session) return;
  active = null;
  clearTimeout(session.maxDurationTimer);
  logger.info('session ended', { voiceSessionId: session.id, reason });
  // D4：通话态标记必须先于任何后续动作解除，别让抬严挂在会话上不下来。
  // 只还「通话」这一张票。语音派出去、还在飞的 run 各自持票，抬严对它们继续有效——
  // 挂断不再等于解除（2026-07-26 真机：挂断后同一个 run 直接落盘，D4 承诺全失效）。
  getPermissionModeManager().clearLiveVoiceSession(session.neoSessionId, `call:${session.id}`);
  // 断开 work item 的 UI 回流；账本与 run 的票继续活到最后一件活落地（同上）。
  endVoiceDispatch();
  // 排水窗：用户 ASR completed / 助手 transcript done 常在挂断后 ~1s 才到，立刻关
  // 上游会把这通电话说过的话全部丢掉（2026-07-26 真机：12s 通话落库只剩摘要）。
  // 窗口内 onEvent 照常把 final 落库；窗口结束后 done 仍没到的助手增量缓冲冲成 final。
  await new Promise((resolve) => setTimeout(resolve, VOICE_TEARDOWN_DRAIN_MS));
  const pendingAssistant = session.transcriptBuf.assistant;
  if (pendingAssistant.trim()) {
    session.transcriptBuf.assistant = '';
    await persistTranscript(session.neoSessionId, 'assistant', pendingAssistant);
  }
  const endedAt = Date.now();
  const { startedAt } = session;
  const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationText = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  recordVoiceCall(endedAt, durationSec);
  try {
    await getSessionManager().addMessageToSession(session.neoSessionId, {
      id: `voice-summary-${endedAt}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: `语音通话结束，时长 ${durationText}`,
      timestamp: endedAt,
      metadata: {
        source: 'voice',
        voiceCallSummary: {
          durationSec,
          provider: session.upstream.provider,
          conversationModel: QWEN_OMNI_REALTIME_MODEL,
          workItemCount: session.workItemCount,
          startedAt,
          endedAt,
        },
      },
    });
  } catch (err) {
    logger.warn('failed to persist call summary', { message: err instanceof Error ? err.message : 'unknown' });
  }
  await session.upstream.close().catch(() => undefined);
  if (session.client.readyState === session.client.OPEN) session.client.close();
}

/**
 * 接管一条来自 Renderer 的媒体面 WS。webServer 的 upgrade 处理器调用。
 * 互斥：已有活跃通话时直接拒绝，不排队。
 */
export async function attachVoiceClient(client: WsSocket, neoSessionId: string, requestedAgentId?: string): Promise<void> {
  if (active || connecting) {
    send(client, { type: 'error', code: 'VOICE_SESSION_BUSY', message: '已有一路通话在进行中' });
    client.close();
    return;
  }

  const apiKey = getDashscopeApiKey();
  if (!apiKey) {
    send(client, { type: 'error', code: 'VOICE_PROVIDER_UNCONFIGURED', message: '未配置 DashScope API Key' });
    client.close();
    return;
  }

  connecting = true;
  try {
    await connectAndBind(client, neoSessionId, apiKey, requestedAgentId);
  } finally {
    connecting = false;
  }
}

async function connectAndBind(
  client: WsSocket,
  neoSessionId: string,
  apiKey: string,
  requestedAgentId?: string,
): Promise<void> {
  const id = `voice-${Date.now()}-${++sessionSeq}`;
  send(client, { type: 'state', state: 'connecting' });

  const routing = resolveVoiceRouting(requestedAgentId);
  const liveSettings = readVoiceLiveSettings();

  const transcriptBuf = { assistant: '' };
  // 绑定必须早于建连：上游一旦握手成功就可能立刻发 function_call，
  // 晚绑一步那次调用会落到「通话还没就绪」的兜底上。
  beginVoiceDispatch({
    neoSessionId,
    activeAgentId: routing.activeAgentId,
    onWorkItem: (item) => {
      if (active?.id === id && item.status === 'queued') active.workItemCount += 1;
      send(client, { type: 'work.upsert', item });
    },
  });
  let upstream: VoiceTransportHandle;
  try {
    upstream = await qwenOmniTransport.connect({
      apiKey,
      config: {
        neoSessionId,
        instructions: withLanguageDirective(routing.personaInstructions, liveSettings?.language),
        tools: VOICE_TOOL_DEFINITIONS,
        ...(liveSettings?.voiceId ? { voice: liveSettings.voiceId } : {}),
      },
      onEvent: (event) => {
        send(client, event);
        if (event.type === 'user.transcript' && event.done) void persistTranscript(neoSessionId, 'user', event.text);
        else if (event.type === 'assistant.transcript') {
          if (event.done) {
            transcriptBuf.assistant = '';
            void persistTranscript(neoSessionId, 'assistant', event.text);
          } else {
            transcriptBuf.assistant += event.text;
          }
        }
        // 上游报错 / 上游连接关闭 = 这一路通话已经死了，必须就地释放 active。
        // 否则两侧对「通话是否结束」的判断会分叉：渲染侧收到 error 就把按钮切回「开始通话」，
        // 而 Host 仍占着 active，用户再拨被自己的互斥挡成 VOICE_SESSION_BUSY，
        // 且此时「挂断」已经点不到——整条语音链锁死到 10 分钟 max-duration 才自愈。
        // （2026-07-26 真机踩到：上游 COMMON_ERROR 后必须重启 app 才能再打。）
        else if (event.type === 'error' || (event.type === 'state' && event.state === 'closed')) {
          if (active?.id === id) void teardown(event.type === 'error' ? 'upstream-error' : 'upstream-closed');
        }
      },
      onAudio: (frame) => {
        if (client.readyState === client.OPEN) client.send(frame, { binary: true });
      },
      onToolCall: (call) => executeVoiceTool(call.name, call.arguments),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connect failed';
    logger.warn('upstream connect failed', { voiceSessionId: id, message });
    endVoiceDispatch();
    send(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE', message });
    client.close();
    return;
  }

  // 客户端在 await 期间就断了：别留悬空的上游连接（会持续计费）。
  if (client.readyState !== client.OPEN) {
    endVoiceDispatch();
    await upstream.close().catch(() => undefined);
    return;
  }

  active = {
    id,
    neoSessionId,
    startedAt: Date.now(),
    client,
    upstream,
    workItemCount: 0,
    transcriptBuf,
    maxDurationTimer: setTimeout(() => {
      logger.warn('session hit max duration, force closing', { voiceSessionId: id });
      void teardown('max-duration');
    }, VOICE_SESSION_MAX_DURATION_MS),
  };
  // D4 抬严必须在有任何工具可派之前就位——建连成功即标记。
  getPermissionModeManager().markLiveVoiceSession(neoSessionId, `call:${id}`);
  logger.info('session started', { voiceSessionId: id, neoSessionId, activeAgentId: routing.activeAgentId });

  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (active?.id !== id) return;
    if (isBinary) {
      // direct 形态的媒体面不经 Host（Renderer 直连上游），这里收到二进制帧只能是
      // 客户端接错了传输形态——丢弃比静默 no-op 转发更接近真相。
      if (upstream.kind === 'relay') upstream.sendAudio(data);
      return;
    }
    let command: VoiceClientCommand;
    try {
      command = JSON.parse(data.toString()) as VoiceClientCommand;
    } catch {
      return;
    }
    if (command.type === 'end') void teardown('client-end');
    else if (command.type === 'interrupt') upstream.interrupt();
    // PTT/点按手动模式：Renderer 松开（或再点按）后提交这一轮。
    // direct 形态的 commit 走它自己的 data channel，不经过 Host——这里没有它的分支是刻意的。
    else if (command.type === 'commit' && upstream.kind === 'relay') upstream.commit();
  });

  client.on('close', () => {
    if (active?.id === id) void teardown('client-closed');
  });
  client.on('error', () => {
    if (active?.id === id) void teardown('client-error');
  });
}

/** 测试用：强制释放当前通话。 */
export async function endActiveVoiceSession(): Promise<void> {
  await teardown('explicit-end');
}
