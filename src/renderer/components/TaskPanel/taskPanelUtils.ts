// ============================================================================
// taskPanelUtils - Shared constants and utility functions for TaskPanel
// ============================================================================
// Extracted from Progress.tsx and TaskMonitor.tsx to eliminate duplication.
// ============================================================================

import React from 'react';
import { Eye, Pencil, Terminal, Search, Plug } from 'lucide-react';

// 工具分类
export type PhaseType = 'read' | 'edit' | 'execute' | 'search' | 'mcp';

export function classifyTool(name: string): PhaseType | null {
  const n = name.toLowerCase();
  if (n.startsWith('mcp__') || n.startsWith('mcp_')) return 'mcp';
  if (['read', 'glob', 'grep'].some(k => n.includes(k))) return 'read';
  if (['edit', 'write'].some(k => n.includes(k))) return 'edit';
  if (n === 'bash' || n.includes('notebook')) return 'execute';
  if (['search', 'fetch'].some(k => n.includes(k))) return 'search';
  return null;
}

// 阶段图标映射
export const PHASE_ICONS: Record<PhaseType, React.FC<{ className?: string }>> = {
  read: Eye,
  edit: Pencil,
  execute: Terminal,
  search: Search,
  mcp: Plug,
};

/**
 * 格式化毫秒为可读时长
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}
