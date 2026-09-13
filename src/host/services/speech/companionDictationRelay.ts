// ============================================================================
// Companion dictation relay: phone PCM16 frames → Gummy. Key stays on Host.
// One stream per device. Events are queued and drained on the next audio/stop.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { GUMMY_REALTIME_SAMPLE_RATE } from '../../../shared/constants/voice';
import type { CompanionDictationEvent } from '../../../shared/contract/companionDictation';
import type { CompanionDictationPort } from '../capabilities/hostCapabilityPorts';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { connectGummyRealtime, type GummyRealtimeHandle } from './gummyRealtimeTransport';

const logger = createLogger('CompanionDictation');

type Session = {
  streamId: string;
  handle: GummyRealtimeHandle;
  events: CompanionDictationEvent[];
  abort: AbortController;
};

const sessions = new Map<string, Session>();

export function hasActiveCompanionDictation(): boolean {
  return sessions.size > 0;
}

function drain(session: Session): CompanionDictationEvent[] {
  const events = session.events;
  session.events = [];
  return events;
}

function drop(deviceId: string): void {
  const session = sessions.get(deviceId);
  if (!session) return;
  sessions.delete(deviceId);
  session.abort.abort();
  session.handle.close();
}

export function createCompanionDictationRelay(): CompanionDictationPort {
  return {
    async open(deviceId) {
      drop(deviceId);
      const apiKey = getDashscopeApiKey();
      if (!apiKey) return { ok: false, code: 'SPEECH_NO_CHANNEL' };
      const streamId = randomUUID();
      const abort = new AbortController();
      const events: CompanionDictationEvent[] = [];
      let handle: GummyRealtimeHandle;
      try {
        handle = await connectGummyRealtime({
          apiKey,
          streamId,
          signal: abort.signal,
          onTranscript: ({ text, sentenceId, done }) => {
            const session = sessions.get(deviceId);
            if (session?.streamId !== streamId) return;
            session.events.push({ type: done ? 'final' : 'partial', text, sentenceId });
          },
          onError: (code, message) => {
            const session = sessions.get(deviceId);
            if (session?.streamId !== streamId) return;
            session.events.push({ type: 'error', code, message });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Gummy realtime connection failed';
        logger.warn('upstream connect failed', { streamId, message });
        return { ok: false, code: 'SPEECH_NO_CHANNEL' };
      }
      if (abort.signal.aborted) {
        handle.close();
        return { ok: false, code: 'SPEECH_NO_CHANNEL' };
      }
      sessions.set(deviceId, { streamId, handle, events, abort });
      return { ok: true, streamId, sampleRate: GUMMY_REALTIME_SAMPLE_RATE };
    },

    audio(deviceId, streamId, pcm) {
      const session = sessions.get(deviceId);
      if (session?.streamId !== streamId) {
        return { ok: false, code: 'COMPANION_DICTATION_INACTIVE', events: [] };
      }
      session.handle.sendAudio(pcm);
      return { ok: true, events: drain(session) };
    },

    async stop(deviceId, streamId) {
      const session = sessions.get(deviceId);
      if (session?.streamId !== streamId) {
        return { ok: false, code: 'COMPANION_DICTATION_INACTIVE', events: [] };
      }
      try {
        await session.handle.finish();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Gummy realtime finish failed';
        session.events.push({ type: 'error', code: 'SPEECH_NO_CHANNEL', message });
      }
      const events = drain(session);
      drop(deviceId);
      return { ok: true, events };
    },

    release(deviceId) {
      drop(deviceId);
    },

    releaseAll() {
      for (const deviceId of [...sessions.keys()]) drop(deviceId);
    },
  };
}
