// ============================================================================
// Workspace Preview Types
// ============================================================================

import type { DesignBrief } from './designBrief';

export type WorkspacePreviewKind =
  | 'document'
  | 'spreadsheet'
  | 'message_draft'
  | 'calendar_event'
  | 'reminder'
  | 'web_snapshot'
  | 'file'
  | 'diff'
  | 'terminal'
  | 'trace'
  | 'handoff'
  | 'generic_html'
  | 'chart'
  | 'diagram'
  | 'question_form';

export type WorkspacePreviewStatus = 'draft' | 'ready' | 'applied' | 'sent' | 'failed';

export type WorkspacePreviewSourceKind =
  | 'message'
  | 'tool'
  | 'connector'
  | 'file'
  | 'permission'
  | 'browser';

export interface WorkspacePreviewSource {
  kind: WorkspacePreviewSourceKind;
  label?: string;
  messageId?: string;
  toolCallId?: string;
  toolName?: string;
  turnNumber?: number;
}

export interface WorkspacePreviewFileRef {
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface WorkspacePreviewAction {
  kind: 'open' | 'edit' | 'copy' | 'download' | 'confirm' | 'apply' | 'send';
  label: string;
  disabled?: boolean;
}

export interface WorkspacePreviewContent {
  text?: string;
  html?: string;
  json?: string;
  diff?: string;
  before?: string;
  after?: string;
  imageDataUrl?: string;
  summary?: string;
}

export interface WorkspacePreviewItem {
  id: string;
  kind: WorkspacePreviewKind;
  title: string;
  subtitle?: string;
  status: WorkspacePreviewStatus;
  createdAt: number;
  source: WorkspacePreviewSource;
  file?: WorkspacePreviewFileRef;
  content?: WorkspacePreviewContent;
  actions?: WorkspacePreviewAction[];
  priority?: number;
  currentTurn?: boolean;
  designBrief?: DesignBrief;
}
