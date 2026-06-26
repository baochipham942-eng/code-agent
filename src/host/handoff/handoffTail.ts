// ============================================================================
// Handoff Tail Parser
// ============================================================================

import type { HandoffProposalDraft } from '../../shared/contract/handoff';

const HANDOFF_TAIL_RE = /(?:\r?\n)*[ \t]*<handoff[-_]proposal>\s*([\s\S]*?)\s*<\/handoff[-_]proposal>[ \t]*(?:\r?\n)*$/i;

export interface HandoffTailExtraction {
  found: boolean;
  cleanedContent: string;
  draft: HandoffProposalDraft | null;
}

function trimToLimit(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, limit);
}

function normalizeJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseWorthHandoff(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parseDraft(raw: string): HandoffProposalDraft | null {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(normalizeJsonPayload(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!parseWorthHandoff(parsed.worthHandoff)) {
    return null;
  }

  const title = trimToLimit(parsed.title, 120);
  const prompt = trimToLimit(parsed.prompt ?? parsed.handoffPrompt, 4000);
  const reason = trimToLimit(parsed.reason, 280);
  if (!title || !prompt) {
    return null;
  }

  return {
    title,
    prompt,
    ...(reason ? { reason } : {}),
  };
}

export function extractHandoffProposalTail(content: string): HandoffTailExtraction {
  const match = HANDOFF_TAIL_RE.exec(content);
  if (match?.index === undefined) {
    return {
      found: false,
      cleanedContent: content,
      draft: null,
    };
  }

  return {
    found: true,
    cleanedContent: content.slice(0, match.index).trimEnd(),
    draft: parseDraft(match[1] || ''),
  };
}
