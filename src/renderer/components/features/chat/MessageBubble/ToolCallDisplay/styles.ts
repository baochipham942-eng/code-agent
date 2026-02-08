// ============================================================================
// ToolCallDisplay Styles - Status colors and status determination
// Uses --cc-* CSS custom properties for Claude Code terminal consistency
// ============================================================================

import type { ToolCall } from '@shared/types';

// ============================================================================
// Status Types
// ============================================================================

export type ToolStatus = 'pending' | 'success' | 'error' | 'interrupted';

export interface StatusColors {
  dot: string;
  text: string;
  border: string;
  bg: string;
}

// ============================================================================
// Status Determination
// ============================================================================

/**
 * Determine tool status based on result and session state
 */
export function getToolStatus(
  toolCall: ToolCall,
  currentSessionId: string | null,
  processingSessionIds: Set<string>
): ToolStatus {
  if (toolCall.result) {
    return toolCall.result.success ? 'success' : 'error';
  }

  const isProcessing = currentSessionId
    ? processingSessionIds.has(currentSessionId)
    : false;

  return isProcessing ? 'pending' : 'interrupted';
}

// ============================================================================
// Status Colors - Claude Code terminal style (cc- tokens)
// ============================================================================

export function getStatusColor(status: ToolStatus): StatusColors {
  switch (status) {
    case 'pending':
      return {
        dot: 'text-[var(--cc-pending)]',
        text: 'text-[var(--cc-pending)]',
        border: 'border-[var(--cc-pending)]/30',
        bg: 'bg-[var(--cc-pending)]/10',
      };
    case 'success':
      return {
        dot: 'text-[var(--cc-success)]',
        text: 'text-[var(--cc-success)]',
        border: 'border-[var(--cc-success)]/30',
        bg: 'bg-[var(--cc-success)]/10',
      };
    case 'error':
      return {
        dot: 'text-[var(--cc-error)]',
        text: 'text-[var(--cc-error)]',
        border: 'border-[var(--cc-error)]/30',
        bg: 'bg-[var(--cc-error)]/10',
      };
    case 'interrupted':
      return {
        dot: 'text-[var(--cc-muted)]',
        text: 'text-[var(--cc-muted)]',
        border: 'border-[var(--cc-muted)]/30',
        bg: 'bg-[var(--cc-muted)]/10',
      };
  }
}

// ============================================================================
// Name Color by Status
// ============================================================================

export function getNameColor(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return 'text-[var(--cc-pending)]';
    case 'success':
      return 'text-[var(--cc-success)]';
    case 'error':
      return 'text-[var(--cc-error)]';
    case 'interrupted':
      return 'text-[var(--cc-muted)]';
    default:
      return 'text-zinc-300';
  }
}
