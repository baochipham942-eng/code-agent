export type PermissionLevel = 'L1_READ' | 'L2_WRITE' | 'L3_EXECUTE';

export interface BridgeToolRequest {
  tool: string;
  params: Record<string, unknown>;
  requestId: string;
}

export interface BridgeToolResponse {
  requestId: string;
  success: boolean;
  output?: string;
  error?: string;
  requiresConfirmation?: boolean;
  confirmationPrompt?: string;
}

export interface BridgeConfig {
  port: number;
  workingDirectories: string[];
  securityLevel: 'strict' | 'normal' | 'relaxed';
  commandWhitelist: string[];
  commandBlacklist: string[];
  autoConfirmL2: boolean;
  shellTimeout: number;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  latestVersion?: string;
  uptime: number;
  workingDirectories: string[];
  toolCount: number;
}

export interface DirectoryTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: DirectoryTreeNode[];
}

export interface ToolContext {
  config: BridgeConfig;
  wsBroadcast: (event: string, payload: Record<string, unknown>) => void;
}

export interface ToolDefinition {
  name: string;
  permissionLevel: PermissionLevel;
  description: string;
  run: (params: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

export interface PendingConfirmation {
  request: BridgeToolRequest;
  permissionLevel: PermissionLevel;
  prompt: string;
  createdAt: number;
}
