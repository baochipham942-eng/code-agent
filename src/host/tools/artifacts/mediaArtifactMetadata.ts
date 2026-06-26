import type { ToolContext } from '../../protocol/tools';

export type MediaArtifactLifecycleKind =
  | 'generated-image'
  | 'edited-image'
  | 'annotated-image'
  | 'image-analysis';

export interface MediaArtifactLifecycleInput {
  kind: MediaArtifactLifecycleKind;
  state?: 'ready' | 'failed';
  operation?: string;
  sourceImages?: string[];
  sourcePrompt?: string;
  fallbackStrategy?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

function compactRecord<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

export function buildMediaArtifactMetadata(
  ctx: Pick<ToolContext, 'sessionId' | 'currentToolCallId' | 'subagent'>,
  input: MediaArtifactLifecycleInput,
): Record<string, unknown> {
  const ownerToolCallId = ctx.currentToolCallId ?? ctx.subagent?.currentToolCallId;
  return {
    mediaLifecycle: compactRecord({
      kind: input.kind,
      state: input.state ?? 'ready',
      operation: input.operation,
      ownerSessionId: ctx.sessionId,
      ownerToolCallId,
      sourceImages: input.sourceImages?.length ? input.sourceImages : undefined,
      sourcePrompt: input.sourcePrompt,
      fallbackStrategy: input.fallbackStrategy,
      fallbackUsed: input.fallbackUsed,
      fallbackReason: input.fallbackReason,
    }),
  };
}
