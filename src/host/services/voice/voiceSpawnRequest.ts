import type { VoiceToolCallOrigin } from '../../../shared/contract/voice';

export interface VoiceSpawnRequest {
  title: string;
  prompt: string;
  shortName: string;
  laneKey: string;
  submissionKey: string;
  origin?: VoiceToolCallOrigin;
}

export function fallbackVoiceTaskShortName(title: string): string {
  const chars = Array.from(title.trim());
  if (chars.length >= 2) return chars.slice(0, 4).join('');
  return `${chars[0] ?? '新'}任务`.slice(0, 4);
}

/** Preserve registered tool identifiers after speech recognition splits or cases them. */
export function canonicalizeVoiceTaskToolNames(text: string): string {
  return text.replace(/\bask[\s_-]*user[\s_-]*question\b/gi, 'AskUserQuestion');
}

export function normalizeVoiceSpawnRequest(input: {
  title: string;
  prompt: string;
  shortName?: string;
  laneKey?: string;
  submissionKey?: string;
  origin?: VoiceToolCallOrigin;
}, uniqueKey: string): VoiceSpawnRequest {
  const shortName = input.shortName?.trim() || fallbackVoiceTaskShortName(input.title);
  return {
    title: input.title,
    prompt: canonicalizeVoiceTaskToolNames(input.prompt),
    shortName,
    laneKey: input.laneKey?.trim() || `legacy:${shortName}`,
    submissionKey: input.submissionKey?.trim() || `legacy:${uniqueKey}`,
    ...(input.origin ? { origin: input.origin } : {}),
  };
}
