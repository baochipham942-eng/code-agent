// ============================================================================
// Permission Types
// ============================================================================

export interface PermissionRequest {
  id: string;
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  tool: string;
  details: {
    path?: string;
    command?: string;
    url?: string;
    changes?: string;
  };
  reason?: string;
  timestamp: number;
}

export type PermissionResponse = 'allow' | 'allow_session' | 'deny';
