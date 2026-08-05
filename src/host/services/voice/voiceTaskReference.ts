import type { VoiceWorkItem } from '../../../shared/contract/voice';

export type VoiceTaskReferenceResolution =
  | { outcome: 'resolved'; item: VoiceWorkItem }
  | { outcome: 'missing' }
  | { outcome: 'ambiguous'; candidates: VoiceWorkItem[] };

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。！？、,.!?：:；;（）()“”"']/g, '');
}

/** 高风险控制只接受唯一命中；多命中与无命中都交给 AskUserQuestion。 */
export function resolveVoiceTaskReference(
  items: VoiceWorkItem[],
  target?: string,
): VoiceTaskReferenceResolution {
  const live = items.filter((item) => item.status === 'queued' || item.status === 'running');
  if (!target?.trim()) {
    if (live.length === 1) return { outcome: 'resolved', item: live[0] };
    return live.length ? { outcome: 'ambiguous', candidates: live } : { outcome: 'missing' };
  }

  const direct = live.filter((item) => item.id === target);
  if (direct.length === 1) return { outcome: 'resolved', item: direct[0] };

  const matchedOrdinal = /^\D*(\d+)\D*$/.exec(target);
  if (matchedOrdinal?.[1]) {
    const item = items[Number(matchedOrdinal[1]) - 1];
    if (item && (item.status === 'queued' || item.status === 'running')) {
      return { outcome: 'resolved', item };
    }
    return { outcome: 'missing' };
  }

  const wanted = normalize(target);
  const exact = live.filter((item) => (
    normalize(item.shortName ?? '') === wanted || normalize(item.title) === wanted
  ));
  if (exact.length === 1) return { outcome: 'resolved', item: exact[0] };
  if (exact.length > 1) return { outcome: 'ambiguous', candidates: exact };

  const contained = live.filter((item) => {
    const shortName = normalize(item.shortName ?? '');
    const title = normalize(item.title);
    return Boolean(wanted && (
      (shortName && (shortName.includes(wanted) || wanted.includes(shortName)))
      || title.includes(wanted)
    ));
  });
  if (contained.length === 1) return { outcome: 'resolved', item: contained[0] };
  return contained.length > 1
    ? { outcome: 'ambiguous', candidates: contained }
    : { outcome: 'missing' };
}

export function voiceTaskOrdinal(items: VoiceWorkItem[], workItemId: string): number {
  return items.findIndex((item) => item.id === workItemId) + 1;
}

export function resolveHistoricalVoiceTask(
  items: VoiceWorkItem[],
  target: string,
): VoiceWorkItem | undefined {
  const direct = items.find((item) => item.id === target);
  if (direct) return direct;
  const ordinal = /^\D*(\d+)\D*$/.exec(target)?.[1];
  return ordinal ? items[Number(ordinal) - 1] : undefined;
}
