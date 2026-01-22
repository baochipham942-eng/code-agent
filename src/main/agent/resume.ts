// ============================================================================
// Session Resume - Resume agent sessions from persisted state
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  getSessionPersistence,
  type PersistedSession,
  type PersistedAgentInstance,
  type SessionIndexEntry,
} from './sessionPersistence';
import { getAgentRegistry, type AgentInstance, type AgentDefinition } from './types';
import type { Message } from '../../shared/types';
import type { PermissionMode } from '../permissions/modes';

const logger = createLogger('SessionResume');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Resume options
 */
export interface ResumeOptions {
  /** Whether to continue from last state or restart */
  continueFromState: boolean;

  /** Override permission mode */
  permissionModeOverride?: PermissionMode;

  /** Additional context to inject */
  additionalContext?: Record<string, unknown>;

  /** Whether to rebuild tool context */
  rebuildToolContext: boolean;

  /** Maximum messages to restore */
  maxMessagesToRestore?: number;
}

/**
 * Resume result
 */
export interface ResumeResult {
  /** Whether resume was successful */
  success: boolean;

  /** Restored session */
  session?: RestoredSession;

  /** Error message if failed */
  error?: string;

  /** Warnings during restore */
  warnings: string[];
}

/**
 * Restored session ready for execution
 */
export interface RestoredSession {
  /** Session ID */
  sessionId: string;

  /** Main agent instance */
  mainAgent: AgentInstance;

  /** Agent definition */
  agentDefinition: AgentDefinition;

  /** Restored messages */
  messages: Message[];

  /** Working directory */
  workingDirectory: string;

  /** Context summary for continuing */
  contextSummary: string;

  /** Last activity timestamp */
  lastActivityAt: number;

  /** Metadata from persisted session */
  metadata?: Record<string, unknown>;
}

/**
 * Session list item for UI
 */
export interface SessionListItem {
  sessionId: string;
  agentName: string;
  workingDirectory: string;
  state: string;
  messageCount: number;
  lastActivity: string;
  canResume: boolean;
}

// ----------------------------------------------------------------------------
// Default Options
// ----------------------------------------------------------------------------

const DEFAULT_RESUME_OPTIONS: ResumeOptions = {
  continueFromState: true,
  rebuildToolContext: true,
  maxMessagesToRestore: 50,
};

// ----------------------------------------------------------------------------
// Session Resume Class
// ----------------------------------------------------------------------------

/**
 * Session Resume Manager
 *
 * Handles restoring agent sessions from persisted state.
 * Rebuilds context, validates state, and prepares for continuation.
 */
export class SessionResume {
  /**
   * Resume a session by ID
   */
  async resume(
    sessionId: string,
    options: Partial<ResumeOptions> = {}
  ): Promise<ResumeResult> {
    const opts: ResumeOptions = { ...DEFAULT_RESUME_OPTIONS, ...options };
    const warnings: string[] = [];

    try {
      // Load persisted session
      const persistence = getSessionPersistence();
      const persisted = await persistence.loadSession(sessionId);

      if (!persisted) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
          warnings: [],
        };
      }

      // Validate and restore
      const result = await this.restoreSession(persisted, opts, warnings);

      return {
        success: true,
        session: result,
        warnings,
      };
    } catch (error) {
      logger.error('Failed to resume session', { sessionId, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        warnings,
      };
    }
  }

  /**
   * Resume the most recent session
   */
  async resumeLatest(options: Partial<ResumeOptions> = {}): Promise<ResumeResult> {
    try {
      const persistence = getSessionPersistence();
      const sessions = await persistence.listSessions();

      if (sessions.length === 0) {
        return {
          success: false,
          error: 'No sessions available to resume',
          warnings: [],
        };
      }

      return this.resume(sessions[0].sessionId, options);
    } catch (error) {
      logger.error('Failed to resume latest session', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        warnings: [],
      };
    }
  }

  /**
   * Resume the most recent session in a specific directory
   */
  async resumeInDirectory(
    workingDirectory: string,
    options: Partial<ResumeOptions> = {}
  ): Promise<ResumeResult> {
    try {
      const persistence = getSessionPersistence();
      const sessions = await persistence.findByWorkingDirectory(workingDirectory);

      if (sessions.length === 0) {
        return {
          success: false,
          error: `No sessions found for directory: ${workingDirectory}`,
          warnings: [],
        };
      }

      return this.resume(sessions[0].sessionId, options);
    } catch (error) {
      logger.error('Failed to resume session in directory', { workingDirectory, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        warnings: [],
      };
    }
  }

  /**
   * List available sessions for resumption
   */
  async listResumable(): Promise<SessionListItem[]> {
    try {
      const persistence = getSessionPersistence();
      const entries = await persistence.listSessions();

      return entries.map(entry => this.toListItem(entry));
    } catch (error) {
      logger.error('Failed to list resumable sessions', { error });
      return [];
    }
  }

  /**
   * Check if a session can be resumed
   */
  async canResume(sessionId: string): Promise<{ canResume: boolean; reason?: string }> {
    try {
      const persistence = getSessionPersistence();
      const session = await persistence.loadSession(sessionId);

      if (!session) {
        return { canResume: false, reason: 'Session not found' };
      }

      // Check if agent definition still exists
      const registry = getAgentRegistry();
      const agentDef = registry.get(session.mainAgent.agentId);
      if (!agentDef) {
        return { canResume: false, reason: 'Agent type no longer available' };
      }

      // Check state
      const nonResumableStates = ['completed', 'failed', 'cancelled'];
      if (nonResumableStates.includes(session.mainAgent.state)) {
        return { canResume: false, reason: `Session already ${session.mainAgent.state}` };
      }

      return { canResume: true };
    } catch (error) {
      return { canResume: false, reason: 'Error checking session' };
    }
  }

  /**
   * Get a summary of a persisted session
   */
  async getSessionSummary(sessionId: string): Promise<string | null> {
    try {
      const persistence = getSessionPersistence();
      const session = await persistence.loadSession(sessionId);

      if (!session) {
        return null;
      }

      return this.generateContextSummary(session);
    } catch (error) {
      logger.error('Failed to get session summary', { sessionId, error });
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async restoreSession(
    persisted: PersistedSession,
    options: ResumeOptions,
    warnings: string[]
  ): Promise<RestoredSession> {
    const registry = getAgentRegistry();

    // Get agent definition
    const agentDef = registry.get(persisted.mainAgent.agentId);
    if (!agentDef) {
      throw new Error(`Agent type not found: ${persisted.mainAgent.agentId}`);
    }

    // Restore agent instance
    const mainAgent = this.restoreAgentInstance(persisted.mainAgent, options, warnings);

    // Restore messages (with limit)
    let messages = persisted.messages;
    if (options.maxMessagesToRestore && messages.length > options.maxMessagesToRestore) {
      const removed = messages.length - options.maxMessagesToRestore;
      messages = messages.slice(-options.maxMessagesToRestore);
      warnings.push(`Truncated ${removed} old messages to stay within limit`);
    }

    // Generate context summary
    const contextSummary = this.generateContextSummary(persisted);

    logger.info('Session restored', {
      sessionId: persisted.sessionId,
      agentId: mainAgent.agentId,
      messageCount: messages.length,
      state: mainAgent.state,
    });

    return {
      sessionId: persisted.sessionId,
      mainAgent,
      agentDefinition: agentDef,
      messages,
      workingDirectory: persisted.workingDirectory,
      contextSummary,
      lastActivityAt: persisted.savedAt,
      metadata: persisted.metadata,
    };
  }

  private restoreAgentInstance(
    persisted: PersistedAgentInstance,
    options: ResumeOptions,
    warnings: string[]
  ): AgentInstance {
    // Determine state
    let state = persisted.state;
    if (!options.continueFromState) {
      // Reset to running if not continuing from state
      if (state !== 'completed' && state !== 'failed' && state !== 'cancelled') {
        state = 'running';
      }
    }

    // Apply permission mode override
    const permissionMode = options.permissionModeOverride || persisted.permissionMode;
    if (options.permissionModeOverride && options.permissionModeOverride !== persisted.permissionMode) {
      warnings.push(`Permission mode overridden from ${persisted.permissionMode} to ${options.permissionModeOverride}`);
    }

    return {
      instanceId: persisted.instanceId,
      agentId: persisted.agentId,
      parentInstanceId: persisted.parentInstanceId,
      sessionId: '', // Will be set by caller
      state,
      createdAt: persisted.createdAt,
      lastActivityAt: Date.now(),
      currentIteration: persisted.currentIteration,
      permissionMode,
      task: persisted.task,
      subagentResults: persisted.subagentResults,
    };
  }

  private generateContextSummary(session: PersistedSession): string {
    const lines: string[] = [];

    lines.push(`Session: ${session.sessionId}`);
    lines.push(`Working Directory: ${session.workingDirectory}`);
    lines.push(`Agent: ${session.mainAgent.agentId}`);
    lines.push(`State: ${session.mainAgent.state}`);
    lines.push(`Messages: ${session.messages.length}`);

    if (session.mainAgent.task) {
      lines.push(`Current Task: ${session.mainAgent.task.description}`);
    }

    // Summarize recent messages
    const recentMessages = session.messages.slice(-5);
    if (recentMessages.length > 0) {
      lines.push('\nRecent conversation:');
      for (const msg of recentMessages) {
        const content = msg.content.substring(0, 100);
        const truncated = msg.content.length > 100 ? '...' : '';
        lines.push(`  [${msg.role}]: ${content}${truncated}`);
      }
    }

    // Summarize tool usage
    if (session.mainAgent.toolHistory && session.mainAgent.toolHistory.length > 0) {
      const tools = [...new Set(session.mainAgent.toolHistory.map(t => t.tool))];
      lines.push(`\nTools used: ${tools.join(', ')}`);
    }

    return lines.join('\n');
  }

  private toListItem(entry: SessionIndexEntry): SessionListItem {
    const now = Date.now();
    const elapsed = now - entry.savedAt;

    let lastActivity: string;
    if (elapsed < 60000) {
      lastActivity = 'Just now';
    } else if (elapsed < 3600000) {
      lastActivity = `${Math.floor(elapsed / 60000)}m ago`;
    } else if (elapsed < 86400000) {
      lastActivity = `${Math.floor(elapsed / 3600000)}h ago`;
    } else {
      lastActivity = `${Math.floor(elapsed / 86400000)}d ago`;
    }

    const resumableStates = ['paused', 'running', 'waiting_permission', 'waiting_user', 'delegating'];

    return {
      sessionId: entry.sessionId,
      agentName: entry.mainAgentId,
      workingDirectory: entry.workingDirectory,
      state: entry.state,
      messageCount: entry.messageCount,
      lastActivity,
      canResume: resumableStates.includes(entry.state),
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let sessionResumeInstance: SessionResume | null = null;

/**
 * Get or create session resume instance
 */
export function getSessionResume(): SessionResume {
  if (!sessionResumeInstance) {
    sessionResumeInstance = new SessionResume();
  }
  return sessionResumeInstance;
}

/**
 * Reset session resume instance (for testing)
 */
export function resetSessionResume(): void {
  sessionResumeInstance = null;
}

/**
 * Convenience function to resume a session
 */
export async function resumeSession(
  sessionId: string,
  options?: Partial<ResumeOptions>
): Promise<ResumeResult> {
  return getSessionResume().resume(sessionId, options);
}

/**
 * Convenience function to resume the latest session
 */
export async function resumeLatestSession(
  options?: Partial<ResumeOptions>
): Promise<ResumeResult> {
  return getSessionResume().resumeLatest(options);
}
