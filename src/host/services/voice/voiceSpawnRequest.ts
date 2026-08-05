export interface VoiceSpawnRequest {
  title: string;
  prompt: string;
  shortName: string;
  laneKey: string;
  submissionKey: string;
}

export function fallbackVoiceTaskShortName(title: string): string {
  const chars = Array.from(title.trim());
  if (chars.length >= 2) return chars.slice(0, 4).join('');
  return `${chars[0] ?? '新'}任务`.slice(0, 4);
}

export function normalizeVoiceSpawnRequest(input: {
  title: string;
  prompt: string;
  shortName?: string;
  laneKey?: string;
  submissionKey?: string;
}, uniqueKey: string): VoiceSpawnRequest {
  const shortName = input.shortName?.trim() || fallbackVoiceTaskShortName(input.title);
  return {
    title: input.title,
    prompt: input.prompt,
    shortName,
    laneKey: input.laneKey?.trim() || `legacy:${shortName}`,
    submissionKey: input.submissionKey?.trim() || `legacy:${uniqueKey}`,
  };
}
