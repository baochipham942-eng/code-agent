export const COLLAB_CARD_METADATA_FIELDS = [
  'title',
  'status',
  'priority',
  'dueAt',
  'updatedAt',
  'requesterUserId',
] as const;

export type CollabCardMetadata = {
  [K in typeof COLLAB_CARD_METADATA_FIELDS[number]]?: unknown;
};

/**
 * C1 的唯一卡元数据出云口。显式挑白名单，不透传整个本地 work card。
 */
export function pickCollabCardMetadata(input: Record<string, unknown>): CollabCardMetadata {
  const output: CollabCardMetadata = {};
  for (const field of COLLAB_CARD_METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      output[field] = input[field];
    }
  }
  return output;
}
