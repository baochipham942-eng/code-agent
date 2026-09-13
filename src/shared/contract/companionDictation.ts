/** Phone ↔ Host dictation frames. Not a persisted companion command. */

export type CompanionDictationEvent =
  | { type: 'partial'; text: string; sentenceId: number }
  | { type: 'final'; text: string; sentenceId: number }
  | { type: 'error'; code: string; message: string };

export type CompanionDictationOpenResult =
  | { ok: true; streamId: string; sampleRate: number }
  | { ok: false; code: string };

export type CompanionDictationFrameResult = {
  ok: boolean;
  code?: string;
  events: CompanionDictationEvent[];
};
