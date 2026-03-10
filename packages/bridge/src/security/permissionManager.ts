import type {
  BridgeConfig,
  BridgeToolRequest,
  PendingConfirmation,
  PermissionLevel,
  ToolDefinition,
} from '../types';

export class PermissionManager {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private config: BridgeConfig) {}

  setConfig(config: BridgeConfig): void {
    this.config = config;
  }

  needsConfirmation(tool: ToolDefinition): boolean {
    if (tool.permissionLevel === 'L1_READ') {
      return false;
    }
    if (tool.permissionLevel === 'L2_WRITE') {
      return !this.config.autoConfirmL2;
    }
    return true;
  }

  buildPrompt(tool: ToolDefinition, params: Record<string, unknown>): string {
    const preview = JSON.stringify(params, null, 2);
    return `Confirm ${tool.permissionLevel} operation "${tool.name}" with params:\n${preview}`;
  }

  createPending(request: BridgeToolRequest, tool: ToolDefinition): PendingConfirmation {
    const pending: PendingConfirmation = {
      request,
      permissionLevel: tool.permissionLevel,
      prompt: this.buildPrompt(tool, request.params),
      createdAt: Date.now(),
    };
    this.pending.set(request.requestId, pending);
    return pending;
  }

  consumePending(requestId: string): PendingConfirmation | undefined {
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
    }
    return pending;
  }

  listPending(): PendingConfirmation[] {
    return [...this.pending.values()];
  }
}
