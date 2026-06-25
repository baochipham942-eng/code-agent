import type { CompressionState } from '../../../context/compressionState';
import {
  findToolResultArchiveRef,
  readToolResultArchive,
  type ToolResultArchiveRef,
} from '../../../utils/toolResultSpill';
import type { ContextTranscriptEntry } from './shared';

const ARCHIVE_ID_RE = /\btool_result:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[a-f0-9]{12}\b/g;
const RAW_EVIDENCE_REQUEST_RE =
  /(?:完整(?:输出|结果|日志|原文)|原始(?:输出|结果|日志|数据)|tool result 原文|tool_result|archive=|read_tool_result_archive|复查(?:输出|结果|日志|原文)|回看(?:输出|结果|日志|原文)|刚才(?:命令|工具).*?(?:输出|结果|日志)|raw evidence|full output|original output|full tool result)/i;
const MAX_AUTO_HYDRATE_CHARS = 24_000;

function getLatestUserContent(entries: ContextTranscriptEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role === 'user') return entry.content || '';
  }
  return '';
}

function getArchiveRefs(state: CompressionState): ToolResultArchiveRef[] {
  const refs: ToolResultArchiveRef[] = [];
  const seen = new Set<string>();
  for (const entry of state.getSnapshot().budgetedResults.values()) {
    const ref = entry.archiveRef;
    if (!ref || seen.has(ref.artifactId)) continue;
    seen.add(ref.artifactId);
    refs.push(ref);
  }
  return refs;
}

function dedupeRefs(refs: ToolResultArchiveRef[]): ToolResultArchiveRef[] {
  const result: ToolResultArchiveRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.artifactId)) continue;
    seen.add(ref.artifactId);
    result.push(ref);
  }
  return result;
}

function pickRequestedArchiveRefs(
  refs: ToolResultArchiveRef[],
  latestUserContent: string,
  sessionId?: string,
): ToolResultArchiveRef[] {
  const explicitIds = new Set(latestUserContent.match(ARCHIVE_ID_RE) ?? []);
  if (explicitIds.size > 0) {
    const byId = new Map(refs.map((ref) => [ref.artifactId, ref]));
    return dedupeRefs(
      Array.from(explicitIds)
        .map((artifactId) => byId.get(artifactId) ?? findToolResultArchiveRef(artifactId, sessionId))
        .filter((ref): ref is ToolResultArchiveRef => Boolean(ref)),
    );
  }

  if (refs.length === 0) return [];
  if (!RAW_EVIDENCE_REQUEST_RE.test(latestUserContent)) return [];
  return [refs[refs.length - 1]];
}

function clampHydratedContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_AUTO_HYDRATE_CHARS) return { content, truncated: false };
  const marker = '\n...[auto-hydrate truncated]...\n';
  const head = Math.floor((MAX_AUTO_HYDRATE_CHARS - marker.length) * 0.65);
  const tail = Math.max(0, MAX_AUTO_HYDRATE_CHARS - marker.length - head);
  return {
    content: `${content.slice(0, head)}${marker}${content.slice(content.length - tail)}`,
    truncated: true,
  };
}

function renderHydratedArchive(ref: ToolResultArchiveRef, content: string, truncated: boolean): string {
  return [
    '[Hydrated archived tool result]',
    `artifactId: ${ref.artifactId}`,
    `tool: ${ref.toolName}`,
    `reason: ${ref.reason}`,
    ref.sourceMessageId ? `sourceMessageId: ${ref.sourceMessageId}` : '',
    ref.toolCallId ? `toolCallId: ${ref.toolCallId}` : '',
    `bytes: ${ref.bytes}`,
    `sha256: ${ref.sha256}`,
    truncated
      ? 'note: This automatic hydrate is truncated; call read_tool_result_archive with the artifact_id for precise paging.'
      : '',
    '',
    content,
  ].filter(Boolean).join('\n');
}

export function applyArchiveHydration(
  entries: ContextTranscriptEntry[],
  state: CompressionState,
  sessionId?: string,
): ContextTranscriptEntry[] {
  const latestUserContent = getLatestUserContent(entries);
  if (!latestUserContent) return entries;

  const requestedRefs = pickRequestedArchiveRefs(getArchiveRefs(state), latestUserContent, sessionId);
  if (requestedRefs.length === 0) return entries;

  const hydratedEntries: ContextTranscriptEntry[] = [];
  for (const ref of requestedRefs.slice(0, 3)) {
    const archive = readToolResultArchive(ref);
    if (!archive) continue;
    const hydrated = clampHydratedContent(archive.content);
    hydratedEntries.push({
      id: `hydrated-archive::${ref.artifactId}`,
      originMessageId: ref.sourceMessageId || ref.toolCallId || ref.artifactId,
      role: 'system',
      content: renderHydratedArchive(ref, hydrated.content, hydrated.truncated),
      timestamp: Date.now(),
      turnIndex: Number.MAX_SAFE_INTEGER,
    });
  }

  if (hydratedEntries.length === 0) return entries;
  return [...entries, ...hydratedEntries];
}
