import type { ModelConfig } from '../../../../shared/contract';
import type { MessageAttachment } from '../../../../shared/contract/message';
import {
  formatHistoricalImageOmission,
  type ImageBudgetLocale,
} from '../../../../shared/i18n/imageBudget';
import type { ContextTranscriptEntry } from './shared';

type ImageBudgetFamily = 'anthropic' | 'gemini' | 'openai';

export interface ImageRequestBudget {
  maxImages: number;
  maxRequestBytes: number;
  reservedRequestBytes: number;
}

const IMAGE_REQUEST_BUDGETS: Record<ImageBudgetFamily, ImageRequestBudget> = {
  // Provider hard limits: 100 images / 32 MB. Keep explicit headroom for
  // provider wrappers, system prompt, tools, and non-image history.
  anthropic: { maxImages: 90, maxRequestBytes: 28_800_000, reservedRequestBytes: 2_000_000 },
  // Gemini's inline request limit is 100 MB. It has no smaller documented
  // image-count limit, so the count guard prevents unbounded arrays while the
  // byte guard is normally decisive.
  gemini: { maxImages: 900, maxRequestBytes: 90_000_000, reservedRequestBytes: 4_000_000 },
  // OpenAI accepts at most 1500 images and 512 MB total payload.
  openai: { maxImages: 1_350, maxRequestBytes: 450_000_000, reservedRequestBytes: 8_000_000 },
};

export interface HistoricalImageBudgetResult {
  entries: ContextTranscriptEntry[];
  family: ImageBudgetFamily;
  budget: ImageRequestBudget;
  keptImages: number;
  omittedImages: number;
  estimatedRequestBytes: number;
  currentImagesExceedBudget: boolean;
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.type === 'image' || attachment.category === 'image';
}

function attachmentPayloadBytes(attachment: MessageAttachment): number {
  const data = attachment.data ?? '';
  const encodedBytes = data
    ? Buffer.byteLength(data, 'utf8')
    : Math.ceil(Math.max(0, attachment.size ?? 0) / 3) * 4;
  return encodedBytes + Buffer.byteLength(attachment.name ?? '', 'utf8') + 256;
}

function resolveImageBudgetFamily(
  config: Pick<ModelConfig, 'provider' | 'model' | 'protocol'>,
): ImageBudgetFamily {
  const provider = String(config.provider ?? '').toLowerCase();
  const model = String(config.model ?? '').toLowerCase();
  if (
    config.protocol === 'claude'
    || provider === 'claude'
    || provider === 'anthropic'
    || model.includes('anthropic/')
    || model.includes('claude')
  ) return 'anthropic';
  if (provider === 'gemini' || model.includes('google/') || model.includes('gemini')) return 'gemini';
  return 'openai';
}

function estimateNonImageRequestBytes(entries: ContextTranscriptEntry[]): number {
  const requestShape = entries.map((entry) => ({
    role: entry.role,
    content: entry.content,
    toolCallId: entry.toolCallId,
    toolCalls: entry.toolCalls,
    thinking: entry.thinking,
    attachments: entry.attachments?.filter((attachment) => !isImageAttachment(attachment)),
  }));
  return Buffer.byteLength(JSON.stringify({ messages: requestShape }), 'utf8');
}

/**
 * Keep every image from the active user turn, then spend the remaining count
 * and request-byte budget on historical images from newest to oldest.
 * The returned projection is detached from the persisted transcript.
 */
export function applyHistoricalImageBudget(
  entries: ContextTranscriptEntry[],
  options: {
    modelConfig: Pick<ModelConfig, 'provider' | 'model' | 'protocol'>;
    currentUserMessageId?: string;
    locale: ImageBudgetLocale;
    budgetOverride?: ImageRequestBudget;
  },
): HistoricalImageBudgetResult {
  const family = resolveImageBudgetFamily(options.modelConfig);
  const budget = options.budgetOverride ?? IMAGE_REQUEST_BUDGETS[family];
  const baseBytes = estimateNonImageRequestBytes(entries) + budget.reservedRequestBytes;
  const keptAttachmentKeys = new Set<string>();
  const historicalCandidates: Array<{
    key: string;
    bytes: number;
  }> = [];
  let keptImages = 0;
  let usedBytes = baseBytes;

  entries.forEach((entry, entryIndex) => {
    entry.attachments?.forEach((attachment, attachmentIndex) => {
      if (!isImageAttachment(attachment)) return;
      const key = `${entryIndex}:${attachmentIndex}`;
      const bytes = attachmentPayloadBytes(attachment);
      if (entry.originMessageId === options.currentUserMessageId) {
        keptAttachmentKeys.add(key);
        keptImages += 1;
        usedBytes += bytes;
      } else {
        historicalCandidates.push({ key, bytes });
      }
    });
  });

  for (let index = historicalCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = historicalCandidates[index];
    if (keptImages >= budget.maxImages) break;
    if (usedBytes + candidate.bytes > budget.maxRequestBytes) continue;
    keptAttachmentKeys.add(candidate.key);
    keptImages += 1;
    usedBytes += candidate.bytes;
  }

  let omittedImages = 0;
  const projectedEntries = entries.map((entry, entryIndex) => {
    if (!entry.attachments?.some(isImageAttachment)) return { ...entry };
    let omittedInMessage = 0;
    const attachments = entry.attachments.filter((attachment, attachmentIndex) => {
      if (!isImageAttachment(attachment)) return true;
      const keep = keptAttachmentKeys.has(`${entryIndex}:${attachmentIndex}`);
      if (!keep) omittedInMessage += 1;
      return keep;
    });
    omittedImages += omittedInMessage;
    const omission = omittedInMessage > 0
      ? formatHistoricalImageOmission(omittedInMessage, options.locale)
      : '';
    return {
      ...entry,
      content: omission ? [entry.content, omission].filter(Boolean).join('\n\n') : entry.content,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  });

  return {
    entries: projectedEntries,
    family,
    budget,
    keptImages,
    omittedImages,
    estimatedRequestBytes: usedBytes,
    currentImagesExceedBudget:
      keptImages > budget.maxImages || usedBytes > budget.maxRequestBytes,
  };
}
