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
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'file'
  | 'diff'
  | 'terminal'
  | 'trace'
  | 'handoff'
  | 'generic_html'
  | 'chart'
  | 'diagram'
  | 'question_form'
  | 'presentation'
  | 'design_ppt';

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
  sha256?: string;
}

export interface WorkspacePreviewAction {
  kind: 'open' | 'edit' | 'copy' | 'download' | 'confirm' | 'apply' | 'send';
  label: string;
  disabled?: boolean;
}

export type WorkspacePreviewQualityStatus = 'passed' | 'needs_review' | 'failed' | 'degraded' | 'unknown';

export interface WorkspacePreviewQuality {
  status: WorkspacePreviewQualityStatus;
  summary: string;
  issueCount?: number;
  blocking?: boolean;
}

export interface WorkspacePreviewRevision {
  artifactId?: string;
  version?: number;
  parentId?: string;
  parentRef?: string;
  filePath?: string;
  sha256?: string;
  sourceTool?: string;
  changeSummary?: string;
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
  quality?: WorkspacePreviewQuality;
  revision?: WorkspacePreviewRevision;
}
