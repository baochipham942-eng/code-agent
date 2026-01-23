// ============================================================================
// ToolCallDisplay Styles - Status colors and status determination
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
  // If tool has a result, check success/error
  if (toolCall.result) {
    return toolCall.result.success ? 'success' : 'error';
  }

  // No result yet - check if session is still processing
  const isProcessing = currentSessionId
    ? processingSessionIds.has(currentSessionId)
    : false;

  return isProcessing ? 'pending' : 'interrupted';
}

// ============================================================================
// Status Colors - Claude Code style
// ============================================================================

export function getStatusColor(status: ToolStatus): StatusColors {
  switch (status) {
    case 'pending':
      return {
        dot: 'bg-cyan-500 animate-pulse',
        text: 'text-cyan-400',
        border: 'border-cyan-500/30',
        bg: 'bg-cyan-500/10',
      };
    case 'success':
      return {
        dot: 'bg-green-500',
        text: 'text-green-400',
        border: 'border-green-500/30',
        bg: 'bg-green-500/10',
      };
    case 'error':
      return {
        dot: 'bg-red-500',
        text: 'text-red-400',
        border: 'border-red-500/30',
        bg: 'bg-red-500/10',
      };
    case 'interrupted':
      return {
        dot: 'bg-gray-500',
        text: 'text-gray-400',
        border: 'border-gray-500/30',
        bg: 'bg-gray-500/10',
      };
  }
}

// ============================================================================
// Name Color by Status
// ============================================================================

export function getNameColor(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return 'text-cyan-400';
    case 'success':
      return 'text-green-400';
    case 'error':
      return 'text-red-400';
    case 'interrupted':
      return 'text-gray-400';
    default:
      return 'text-gray-300';
  }
}
