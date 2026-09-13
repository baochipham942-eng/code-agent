import type { UserQuestionRequest, UserQuestionResponse } from '../../../shared/contract';
import type { SpeechTranscribeOptions, SpeechTranscribeResult } from '../../../shared/contract/speech';
import type {
  CompanionDictationFrameResult,
  CompanionDictationOpenResult,
} from '../../../shared/contract/companionDictation';

export type HostCapabilityCleanup = () => void | Promise<void>;
export type TurnOutcomeResolver = (
  sessionId: string,
  dispatchedAtMs: number,
) => Promise<'done' | 'unverified'>;

/**
 * Structural mirror of the speech package's request. Declared here on purpose: host core
 * must not import anything under services/speech, type-only imports included.
 */
interface SpeechTranscriptionInput extends SpeechTranscribeOptions {
  audioData?: string;
  mimeType: string;
}
export type SpeechTranscriber = (request: SpeechTranscriptionInput) => Promise<SpeechTranscribeResult>;

/**
 * Companion dictation relay. Declared here so host/companion can call it without
 * importing `services/speech` (voiceHostReverseDependency).
 */
export interface CompanionDictationPort {
  open(deviceId: string): Promise<CompanionDictationOpenResult>;
  audio(deviceId: string, streamId: string, pcm: Buffer): CompanionDictationFrameResult;
  stop(deviceId: string, streamId: string): Promise<CompanionDictationFrameResult>;
  release(deviceId: string): void;
  releaseAll(): void;
}

export interface UserQuestionRoute {
  canOffer: (sessionId: string | undefined) => boolean;
  offer: (
    request: UserQuestionRequest,
    respond: (response: UserQuestionResponse) => void,
  ) => boolean;
  cancel: (requestId: string) => void;
}

let turnOutcomeResolver: TurnOutcomeResolver | null = null;
const userQuestionRoutes: UserQuestionRoute[] = [];
let voiceInstructionsRefresher: (() => void) | null = null;
let speechTranscriber: SpeechTranscriber | null = null;
let companionDictation: CompanionDictationPort | null = null;

function exclusiveRegistration<T>(
  current: T | null,
  next: T,
  label: string,
  clear: () => void,
): HostCapabilityCleanup {
  if (current && current !== next) throw new Error(`${label} already has a registered provider`);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    clear();
  };
}

export function registerTurnOutcomeResolver(resolver: TurnOutcomeResolver): HostCapabilityCleanup {
  const cleanup = exclusiveRegistration(
    turnOutcomeResolver,
    resolver,
    'turn outcome resolver',
    () => {
      if (turnOutcomeResolver === resolver) turnOutcomeResolver = null;
    },
  );
  turnOutcomeResolver = resolver;
  return cleanup;
}

export async function resolveRegisteredTurnOutcome(
  sessionId: string,
  dispatchedAtMs: number,
): Promise<'done' | 'unverified'> {
  return turnOutcomeResolver
    ? turnOutcomeResolver(sessionId, dispatchedAtMs)
    : 'unverified';
}

export function registerUserQuestionRoute(route: UserQuestionRoute): HostCapabilityCleanup {
  // Fan-out, not exclusive: the voice bridge and the companion phone both need
  // the same pending question. A single slot would let whichever registers
  // second steal the route (or throw), so a live voice call would squeeze the
  // phone out — or the phone would squeeze the voice call out.
  userQuestionRoutes.push(route);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = userQuestionRoutes.indexOf(route);
    if (index >= 0) userQuestionRoutes.splice(index, 1);
  };
}

export function canOfferRegisteredUserQuestion(sessionId: string | undefined): boolean {
  return userQuestionRoutes.some(route => route.canOffer(sessionId));
}

export function offerRegisteredUserQuestion(
  request: UserQuestionRequest,
  respond: (response: UserQuestionResponse) => void,
): boolean {
  let offered = false;
  for (const route of [...userQuestionRoutes]) {
    if (route.offer(request, respond)) offered = true;
  }
  return offered;
}

export function cancelRegisteredUserQuestion(requestId: string): void {
  for (const route of [...userQuestionRoutes]) route.cancel(requestId);
}

export function registerSpeechTranscriber(transcriber: SpeechTranscriber): HostCapabilityCleanup {
  const cleanup = exclusiveRegistration(
    speechTranscriber,
    transcriber,
    'speech transcriber',
    () => {
      if (speechTranscriber === transcriber) speechTranscriber = null;
    },
  );
  speechTranscriber = transcriber;
  return cleanup;
}

/** null when the voice-input capability is not installed — callers must fail closed, not wait. */
export function getRegisteredSpeechTranscriber(): SpeechTranscriber | null {
  return speechTranscriber;
}

export function registerCompanionDictation(port: CompanionDictationPort): HostCapabilityCleanup {
  const cleanup = exclusiveRegistration(
    companionDictation,
    port,
    'companion dictation',
    () => {
      if (companionDictation === port) companionDictation = null;
    },
  );
  companionDictation = port;
  return cleanup;
}

/** null when the voice-input capability is not installed — phone must stay on chunked transcribe. */
export function getRegisteredCompanionDictation(): CompanionDictationPort | null {
  return companionDictation;
}

export function registerVoiceInstructionsRefresher(refresher: () => void): HostCapabilityCleanup {
  const cleanup = exclusiveRegistration(
    voiceInstructionsRefresher,
    refresher,
    'voice instructions refresher',
    () => {
      if (voiceInstructionsRefresher === refresher) voiceInstructionsRefresher = null;
    },
  );
  voiceInstructionsRefresher = refresher;
  return cleanup;
}

export function refreshRegisteredVoiceInstructions(): void {
  voiceInstructionsRefresher?.();
}
