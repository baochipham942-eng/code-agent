import type { VoiceProviderId } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';
import type { VoiceInterruptCandidate } from './voiceInterruptCandidates';
import {
  collectVoiceInterruptEvidence,
  sampleVoiceInterruptEvidence,
  type VoiceInterruptEvidence,
} from './voiceInterruptEvidence';
import {
  decideVoiceInterrupt,
  type VoiceInterruptDecision,
} from './voiceTurnTaking';

const logger = createLogger('VoiceSession');

export function evaluateVoiceInterruptDecision(input: {
  candidate: VoiceInterruptCandidate;
  candidates: Iterable<VoiceInterruptCandidate>;
  assistantPlaying: boolean;
  text: string;
  stage: 'partial' | 'final';
  speakerMismatch: boolean;
}): {
  decision: VoiceInterruptDecision;
  evidence: VoiceInterruptEvidence;
  priorStartedAt: number[];
} {
  const priorStartedAt = [...input.candidates]
    .filter((other) => other !== input.candidate)
    .map((other) => other.startedAt);
  const evidence = collectVoiceInterruptEvidence({
    startedAt: input.candidate.startedAt,
    durationMs: input.candidate.durationMs,
    assistantPlaying: input.assistantPlaying,
    playedMs: input.candidate.playedMs,
    priorStartedAt,
    text: input.text,
  });
  const decision = decideVoiceInterrupt({
    assistantPlaying: input.assistantPlaying,
    durationMs: input.candidate.durationMs,
    text: input.text,
    stage: input.stage,
    // 声纹只有明确 mismatch 才收紧；unknown/match 都由调用侧传 false，继续交 L2。
    speakerMismatch: input.speakerMismatch,
    evidenceTier: evidence.tier,
  });
  return { decision, evidence, priorStartedAt };
}

export function recordVoiceInterruptDecisionSample(input: {
  provider: VoiceProviderId;
  voiceSessionId: string;
  candidateId: string;
  candidate: VoiceInterruptCandidate;
  assistantPlaying: boolean;
  priorStartedAt: readonly number[];
  text: string;
  decision: VoiceInterruptDecision;
  evidence: VoiceInterruptEvidence;
}): void {
  sampleVoiceInterruptEvidence({
    provider: input.provider,
    voiceSessionId: input.voiceSessionId,
    candidateId: input.candidateId,
    startedAt: input.candidate.startedAt,
    durationMs: input.candidate.durationMs,
    playedMs: input.candidate.playedMs,
    assistantPlaying: input.assistantPlaying,
    priorStartedAt: input.priorStartedAt,
    text: input.text,
    decidedClassification: input.decision.classification,
    decidedCancel: input.decision.cancel,
    evidence: input.evidence,
  });
}

export function logVoiceInterruptDecision(input: {
  voiceSessionId: string;
  candidateId: string;
  transcriptStage: 'partial' | 'final';
  action: 'resume' | 'hold';
  responseId?: string;
  decision: VoiceInterruptDecision;
  evidence: VoiceInterruptEvidence;
}): void {
  logger.info('voice interrupt decision', {
    voiceSessionId: input.voiceSessionId,
    candidateId: input.candidateId,
    transcriptStage: input.transcriptStage,
    classification: input.decision.classification,
    action: input.action,
    responseId: input.responseId,
    evidenceTier: input.evidence.tier,
    evidenceScore: input.evidence.score,
    layer: input.decision.evidenceGated ? 'evidence_gate' : 'semantic_gate',
    ...(input.decision.speakerGated ? { speakerGated: true } : {}),
    ...(input.decision.evidenceGated ? { evidenceGated: true } : {}),
  });
}
