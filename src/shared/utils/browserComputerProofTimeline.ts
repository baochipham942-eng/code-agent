import type {
  BrowserComputerProofTimelineEntry,
  ReplayBlock,
  ReplayTurn,
  StructuredReplay,
} from '../contract/evaluation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function extractTraceId(metadata: Record<string, unknown>): string | null {
  const direct = stringValue(metadata.traceId);
  if (direct) return direct;
  const trace = isRecord(metadata.workbenchTrace) ? metadata.workbenchTrace : null;
  return stringValue(trace?.id) ?? null;
}

function proofTimelineEntryFromBlock(turn: ReplayTurn, block: ReplayBlock): BrowserComputerProofTimelineEntry | null {
  const toolCall = block.toolCall;
  const metadata = toolCall?.resultMetadata;
  if (!toolCall || !metadata) return null;
  const card = isRecord(metadata.browserComputerEvidenceCard) ? metadata.browserComputerEvidenceCard : null;
  const proof = isRecord(metadata.browserComputerProof) ? metadata.browserComputerProof : null;
  if (!card && !proof) return null;

  const visualObservation = isRecord(proof?.visualObservation) ? proof.visualObservation : null;
  const manualTakeover = isRecord(proof?.manualTakeover) ? proof.manualTakeover : null;
  return {
    turnNumber: turn.turnNumber,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status: stringValue(card?.status) ?? (manualTakeover ? 'manual_takeover' : 'observed'),
    summary: stringValue(card?.summary) ?? 'Browser/Computer proof captured',
    evidenceRefIds: stringArray(card?.evidenceRefIds),
    timestamp: block.timestamp,
    traceId: extractTraceId(metadata),
    visualSource: stringValue(visualObservation?.source) ?? null,
    manualTakeoverStatus: stringValue(manualTakeover?.status) ?? null,
  };
}

export function collectBrowserComputerProofTimeline(turns: ReplayTurn[]): BrowserComputerProofTimelineEntry[] {
  return turns.flatMap((turn) =>
    turn.blocks.flatMap((block) => {
      const entry = proofTimelineEntryFromBlock(turn, block);
      return entry ? [entry] : [];
    }),
  );
}

export function attachBrowserComputerProofTimeline(replay: StructuredReplay): StructuredReplay {
  const timeline = collectBrowserComputerProofTimeline(replay.turns);
  if (timeline.length === 0) return replay;
  return {
    ...replay,
    summary: {
      ...replay.summary,
      browserComputerProofTimeline: timeline,
    },
  };
}
