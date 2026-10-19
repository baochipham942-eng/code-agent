// voiceSessionService 的打断判定与回应路由（N-MAXLINES-MINEFIELD-2-FU1-S3 逐字拆出）。
// 唯一的形状变化：原函数直接读 voiceSessionService 的模块级 `active`，拆出后改为
// 由调用方传入 isSessionLive（同一判据 `active?.id === session.id` 的参数化）。
import type { WebSocket as WsSocket } from 'ws';
import type { VoiceEvent } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';
import { buildVoiceTurnPrompt, detectVoiceReceptionAmbiguity, requiresVoiceActionTool, resolveVoiceActionRoute } from './voiceRouting';
import { executeVoiceTool } from './voiceTools';
import { resolveInterruptCandidate } from './voiceInterruptCandidates';
import {
  evaluateVoiceInterruptDecision,
  logVoiceInterruptDecision,
  recordVoiceInterruptDecisionSample,
} from './voiceInterruptDecision';
import { beginFalseInterruptionWindow, confirmHeldInterrupt } from './voiceFalseInterruption';
import type { ActiveSession } from './voiceSessionTypes';

const logger = createLogger('VoiceSession');

export function send(client: WsSocket, event: VoiceEvent): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

export function rememberCancelledResponse(session: ActiveSession, responseId: string): void {
  session.cancelledResponseIds.add(responseId);
  session.pendingAssistantFinals.delete(responseId);
  session.transcriptBuf.assistantByResponse.delete(responseId);
  session.narrationResponses.delete(responseId);
  while (session.cancelledResponseIds.size > 32) {
    const oldest = session.cancelledResponseIds.values().next().value as string | undefined;
    if (!oldest) break;
    session.cancelledResponseIds.delete(oldest);
  }
}

async function requestResponse(
  isSessionLive: (session: ActiveSession) => boolean,
  session: ActiveSession,
  userFinal: string,
): Promise<void> {
  if (session.upstream.kind !== 'relay') return;
  const latest = userFinal.trim();
  const ambiguity = detectVoiceReceptionAmbiguity(latest);
  const route = ambiguity ? undefined : resolveVoiceActionRoute(latest);
  if (route && session.voiceToolsAvailable) {
    logger.info('voice action tool accepted', { provider: session.upstream.provider, origin: 'host_routed', toolName: route.toolName });
    const output = await executeVoiceTool(route.toolName, route.rawArguments, 'host_routed');
    if (!isSessionLive(session) || session.ending || session.upstream.kind !== 'relay') return;
    session.upstream.respond(`Host 已按用户最新一句话执行了对应工具。只简短说明工具结果，不要再次调用工具。\n用户最新一句话：${latest}\n工具结果：${output}`, 'auto'); return;
  }
  session.upstream.respond(
    buildVoiceTurnPrompt(latest),
    !ambiguity && requiresVoiceActionTool(latest) ? 'required' : 'auto',
  );
}

export function evaluateInterrupt(
  isSessionLive: (session: ActiveSession) => boolean,
  session: ActiveSession,
  text: string,
  stage: 'partial' | 'final',
  identity: { candidateId?: string; itemId?: string; classificationSource?: 'empty-text-fallback' | 'transcript' } = {},
): void {
  const resolved = resolveInterruptCandidate(session.interruption, identity);
  const candidateId = resolved?.candidateId;
  if (!candidateId) {
    if (stage === 'final' && text.trim()) void requestResponse(isSessionLive, session, text);
    return;
  }
  const candidate = resolved.candidate;
  if (stage === 'final' && candidate.finalGraceTimer) {
    clearTimeout(candidate.finalGraceTimer);
    candidate.finalGraceTimer = undefined;
  }
  const assistantPlaying = candidate.assistantPlaying
    ?? (session.upstream.kind === 'relay' && session.upstream.isResponding());
  const { decision, evidence: interruptEvidence, priorStartedAt } = evaluateVoiceInterruptDecision({
    candidate,
    candidates: session.interruption.candidates.values(),
    assistantPlaying,
    text,
    stage,
    speakerMismatch: session.speaker.tracker?.verdictFor(candidateId) === 'mismatch',
  });

  // L2 证据闸：判定与遥测消费同一份 evidence，避免「量的一套、判的另一套」。
  if (decision.terminal && !candidate.decided) {
    recordVoiceInterruptDecisionSample({
      provider: session.upstream.provider,
      voiceSessionId: session.id,
      candidateId,
      candidate,
      assistantPlaying,
      priorStartedAt,
      text,
      decision,
      evidence: interruptEvidence,
    });
  }

  // 用途一读图重点：在 no_playback 轮真的开口对话的人，当场纳入活跃集，不设观察期
  // ——中途换人第一句就被接纳（判据 4），电视永远不参与对话轮所以进不来。
  if (decision.classification === 'no_playback' && stage === 'final' && text.trim()) {
    session.speaker.tracker?.admitCandidate(candidateId);
  }

  if (decision.terminal && !candidate.decided) {
    candidate.decided = true;
    candidate.classification = decision.classification;
    candidate.classificationSource = identity.classificationSource ?? 'transcript';
    let cancelledResponseId: string | null = null;
    if (decision.cancel) {
      cancelledResponseId = session.upstream.interrupt();
      if (cancelledResponseId) {
        candidate.cancelledResponseId = cancelledResponseId;
        rememberCancelledResponse(session, cancelledResponseId);
      }
    }
    const action = decision.cancel ? 'hold' : 'resume';
    send(session.clientRef.current, {
      type: 'interrupt.decision',
      candidateId,
      classification: decision.classification,
      action,
      ...(cancelledResponseId ? { responseId: cancelledResponseId } : {}),
    });
    if (decision.cancel) {
      beginFalseInterruptionWindow(session, candidateId, candidate, () => isSessionLive(session));
    }
    logVoiceInterruptDecision({
      voiceSessionId: session.id,
      candidateId,
      transcriptStage: stage,
      action,
      responseId: cancelledResponseId ?? undefined,
      decision,
      evidence: interruptEvidence,
    });
  }

  // partial 先触发 hold 时，后续 final 是「用户确实继续说」的确认信号；此时才真丢。
  if (stage === 'final' && text.trim()) {
    confirmHeldInterrupt(session, candidateId, candidate, 'final_transcript');
  }
  if (stage === 'final' && decision.shouldRespond && !candidate.responseRequested) {
    candidate.responseRequested = true;
    void requestResponse(isSessionLive, session, text);
  }
}
