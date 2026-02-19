// ============================================================================
// IDE Bridge - Interface definition for future IDE integration
// ============================================================================
// This file defines the interface for IDE communication.
// Implementation is deferred; this serves as an architectural placeholder.
// ============================================================================

export interface IDEFileEvent {
  filePath: string;
  language?: string;
  content?: string;
}

export interface IDECursorEvent {
  filePath: string;
  line: number;
  column: number;
  selection?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export interface IDEEditRequest {
  filePath: string;
  edits: Array<{
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    newText: string;
  }>;
}

export interface IDEDiffRequest {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  title?: string;
}

export interface IDEBridge {
  // Events from IDE
  onFileOpen(handler: (event: IDEFileEvent) => void): void;
  onFileSave(handler: (event: IDEFileEvent) => void): void;
  onCursorChange(handler: (event: IDECursorEvent) => void): void;

  // Actions to IDE
  applyEdit(request: IDEEditRequest): Promise<boolean>;
  showDiff(request: IDEDiffRequest): Promise<void>;
  openFile(filePath: string, line?: number): Promise<void>;
  showNotification(message: string, type?: 'info' | 'warning' | 'error'): void;

  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
}

export type IDEType = 'vscode' | 'cursor' | 'jetbrains' | 'neovim';
