// ============================================================================
// Agent Orchestrator - Main controller for the AI agent
// ============================================================================

import type {
  AgentConfig,
  AgentEvent,
  Message,
  ToolCall,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  Generation,
  ModelConfig,
} from '../../shared/types';
import { AgentLoop } from './AgentLoop';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import type { GenerationManager } from '../generation/GenerationManager';
import type { ConfigService } from '../services/ConfigService';
import { getSessionManager } from '../services/SessionManager';
import type { PlanningService } from '../planning';
import { generateMessageId, generatePermissionRequestId } from '../../shared/utils/id';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface AgentOrchestratorConfig {
  generationManager: GenerationManager;
  configService: ConfigService;
  onEvent: (event: AgentEvent) => void;
  planningService?: PlanningService;
}

// ----------------------------------------------------------------------------
// Agent Orchestrator
// ----------------------------------------------------------------------------

export class AgentOrchestrator {
  private generationManager: GenerationManager;
  private configService: ConfigService;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private agentLoop: AgentLoop | null = null;
  private onEvent: (event: AgentEvent) => void;
  private workingDirectory: string;
  private messages: Message[] = [];
  private pendingPermissions: Map<string, {
    resolve: (response: PermissionResponse) => void;
    request: PermissionRequest;
  }> = new Map();
  private planningService?: PlanningService;

  constructor(config: AgentOrchestratorConfig) {
    this.generationManager = config.generationManager;
    this.configService = config.configService;
    this.onEvent = config.onEvent;
    // Default to current working directory
    this.workingDirectory = process.cwd();
    console.log('[AgentOrchestrator] Initial working directory:', this.workingDirectory);
    this.planningService = config.planningService;

    // Initialize tool registry and executor
    this.toolRegistry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor({
      toolRegistry: this.toolRegistry,
      requestPermission: this.requestPermission.bind(this),
      workingDirectory: this.workingDirectory,
    });
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async sendMessage(content: string): Promise<void> {
    const generation = this.generationManager.getCurrentGeneration();
    const settings = this.configService.getSettings();
    const sessionManager = getSessionManager();

    // Create user message
    const userMessage: Message = {
      id: this.generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    this.messages.push(userMessage);
    // Note: Don't emit user message event - frontend already added it

    // 持久化保存用户消息
    try {
      await sessionManager.addMessage(userMessage);
    } catch (error) {
      console.error('Failed to save user message:', error);
    }

    // Get model config
    const modelConfig = this.getModelConfig(settings);

    // Create agent loop
    this.agentLoop = new AgentLoop({
      generation,
      modelConfig,
      toolRegistry: this.toolRegistry,
      toolExecutor: this.toolExecutor,
      messages: this.messages,
      onEvent: this.onEvent,
      planningService: this.planningService,
    });

    try {
      // Run agent loop
      console.log('[AgentOrchestrator] ========== Starting agent loop ==========');
      await this.agentLoop.run(content);
      console.log('[AgentOrchestrator] ========== Agent loop completed normally ==========');
    } catch (error) {
      console.error('[AgentOrchestrator] ========== Agent loop EXCEPTION ==========');
      console.error('[AgentOrchestrator] Error:', error);
      console.error('[AgentOrchestrator] Stack:', error instanceof Error ? error.stack : 'no stack');
      this.onEvent({
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    } finally {
      console.log('[AgentOrchestrator] ========== Finally block, agentLoop = null ==========');
      this.agentLoop = null;
    }
  }

  async cancel(): Promise<void> {
    if (this.agentLoop) {
      this.agentLoop.cancel();
      this.agentLoop = null;
    }
  }

  handlePermissionResponse(requestId: string, response: PermissionResponse): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingPermissions.delete(requestId);
    }
  }

  setWorkingDirectory(path: string): void {
    this.workingDirectory = path;
    this.toolExecutor.setWorkingDirectory(path);
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  setPlanningService(service: PlanningService): void {
    this.planningService = service;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async requestPermission(request: Omit<PermissionRequest, 'id' | 'timestamp'>): Promise<boolean> {
    const fullRequest: PermissionRequest = {
      ...request,
      id: generatePermissionRequestId(),
      timestamp: Date.now(),
    };

    // Auto-approve all permissions in AUTO_TEST mode
    if (process.env.AUTO_TEST) {
      console.log(`[AUTO_TEST] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    // Check auto-approve settings
    const settings = this.configService.getSettings();
    const permissionLevel = this.getPermissionLevel(request.type);

    // Dev mode: auto-approve all permissions (configurable)
    if (settings.permissions.devModeAutoApprove) {
      console.log(`[DevMode] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    if (settings.permissions.autoApprove[permissionLevel]) {
      return true;
    }

    // Send permission request to UI with timeout
    const PERMISSION_TIMEOUT = 60000; // 60 seconds timeout

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Timeout - deny permission
        this.pendingPermissions.delete(fullRequest.id);
        console.warn(`[Permission] Timeout for ${request.type} on ${request.tool}, denying`);
        resolve(false);
      }, PERMISSION_TIMEOUT);

      this.pendingPermissions.set(fullRequest.id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          resolve(response === 'allow' || response === 'allow_session');
        },
        request: fullRequest,
      });
      this.onEvent({ type: 'permission_request', data: fullRequest });
    });
  }

  private getPermissionLevel(type: PermissionRequest['type']): 'read' | 'write' | 'execute' | 'network' {
    switch (type) {
      case 'file_read':
        return 'read';
      case 'file_write':
      case 'file_edit':
        return 'write';
      case 'command':
      case 'dangerous_command':
        return 'execute';
      case 'network':
        return 'network';
      default:
        return 'read';
    }
  }

  private getModelConfig(settings: ReturnType<ConfigService['getSettings']>): ModelConfig {
    const defaultProvider = 'deepseek';
    const apiKey = this.configService.getApiKey(defaultProvider);

    console.log(`[AgentOrchestrator] Using provider: ${defaultProvider}`);
    console.log(`[AgentOrchestrator] API Key exists: ${!!apiKey}`);
    console.log(`[AgentOrchestrator] API Key prefix: ${apiKey?.substring(0, 10)}...`);

    return {
      provider: defaultProvider,
      model: 'deepseek-chat',
      apiKey,
      temperature: 0.7,
      maxTokens: 4096,
    };
  }

  private generateId(): string {
    return generateMessageId();
  }
}
