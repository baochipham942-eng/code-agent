// ============================================================================
// Companion dictation relay: phone PCM16 frames → Gummy. Key stays on Host.
// One stream per device. Events are queued and drained on the next audio/stop.
// ============================================================================

import { randomUUID } from 'node:crypto';
import {
  GUMMY_REALTIME_FINISH_TIMEOUT_MS,
  GUMMY_REALTIME_PRESTART_FRAME_LIMIT,
  GUMMY_REALTIME_SAMPLE_RATE,
} from '../../../shared/constants/voice';
import { COMPANION_LIMITS } from '../../../shared/constants/companion';
import type { CompanionDictationEvent } from '../../../shared/contract/companionDictation';
import type { CompanionDictationPort } from '../capabilities/hostCapabilityPorts';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { connectGummyRealtime, type GummyRealtimeHandle } from './gummyRealtimeTransport';

const logger = createLogger('CompanionDictation');

type Session = {
  streamId: string;
  handle: GummyRealtimeHandle | null;
  pending: Buffer[];
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
  session.handle?.close();
}

export function createCompanionDictationRelay(): CompanionDictationPort {
  return {
    async open(deviceId) {
      drop(deviceId);
      const apiKey = getDashscopeApiKey();
      if (!apiKey) return { ok: false, code: 'SPEECH_NO_CHANNEL' };
      const streamId = randomUUID();
      const abort = new AbortController();
      const session: Session = { streamId, handle: null, pending: [], events: [], abort };
      sessions.set(deviceId, session);
      // Must not await Gummy here: LAN exchange times out at 10s, Gummy connect waits 15s.
      void connectGummyRealtime({
        apiKey,
        streamId,
        signal: abort.signal,
        onTranscript: ({ text, sentenceId, done }) => {
          const current = sessions.get(deviceId);
          if (current?.streamId !== streamId) return;
          current.events.push({ type: done ? 'final' : 'partial', text, sentenceId });
        },
        onError: (code, message) => {
          const current = sessions.get(deviceId);
          if (current?.streamId !== streamId) return;
          current.events.push({ type: 'error', code, message });
        },
      }).then(handle => {
        const current = sessions.get(deviceId);
        if (current?.streamId !== streamId || abort.signal.aborted) {
          handle.close();
          return;
        }
        current.handle = handle;
        for (const frame of current.pending) handle.sendAudio(frame);
        current.pending = [];
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Gummy realtime connection failed';
        logger.warn('upstream connect failed', { streamId, message });
        const current = sessions.get(deviceId);
        if (current?.streamId === streamId) {
          current.events.push({ type: 'error', code: 'SPEECH_NO_CHANNEL', message });
        }
      });
      return { ok: true, streamId, sampleRate: GUMMY_REALTIME_SAMPLE_RATE };
    },

    audio(deviceId, streamId, pcm) {
      const session = sessions.get(deviceId);
      if (session?.streamId !== streamId) {
        return { ok: false, code: 'COMPANION_DICTATION_INACTIVE', events: [] };
      }
      if (session.handle) session.handle.sendAudio(pcm);
      else if (session.pending.length < GUMMY_REALTIME_PRESTART_FRAME_LIMIT) session.pending.push(pcm);
      else if (!session.events.some(event => event.type === 'error')) {
        session.events.push({ type: 'error', code: 'SPEECH_NO_CHANNEL', message: 'prestart overflow' });
      }
      return { ok: true, events: drain(session) };
    },

    async stop(deviceId, streamId) {
      const session = sessions.get(deviceId);
      if (session?.streamId !== streamId) {
        return { ok: false, code: 'COMPANION_DICTATION_INACTIVE', events: [] };
      }
      const deadline = Date.now() + Math.max(0, COMPANION_LIMITS.requestTimeoutMs - GUMMY_REALTIME_FINISH_TIMEOUT_MS - 1_000);
      while (!session.handle && Date.now() < deadline && sessions.get(deviceId) === session) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      try {
        if (session.handle) await session.handle.finish();
        else session.events.push({ type: 'error', code: 'SPEECH_NO_CHANNEL', message: 'upstream connect incomplete' });
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
