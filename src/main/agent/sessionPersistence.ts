// ============================================================================
// Session Persistence - Persist and restore agent sessions
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../services/infra/logger';
import type {
  AgentInstance,
  AgentTask,
  SubagentResult,
  AgentInstanceState,
} from './types';
import type { PermissionMode } from '../permissions/modes';
import type { Message } from '../../shared/types';

const logger = createLogger('SessionPersistence');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Persisted session state
 */
export interface PersistedSession {
  /** Session version for migration */
  version: number;

  /** Session ID */
  sessionId: string;

  /** Main agent instance */
  mainAgent: PersistedAgentInstance;

  /** Sub-agent instances */
  subAgents: PersistedAgentInstance[];

  /** Conversation messages */
  messages: Message[];

  /** Working directory */
  workingDirectory: string;

  /** Creation timestamp */
  createdAt: number;

  /** Last save timestamp */
  savedAt: number;

  /** Session metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Persisted agent instance (serializable version)
 */
export interface PersistedAgentInstance {
  /** Instance ID */
  instanceId: string;

  /** Agent definition ID */
  agentId: string;

  /** Parent instance ID */
  parentInstanceId?: string;

  /** Current state */
  state: AgentInstanceState;

  /** Permission mode */
  permissionMode: PermissionMode;

  /** Current iteration */
  currentIteration: number;

  /** Current task */
  task?: AgentTask;

  /** Completed sub-agent results */
  subagentResults?: SubagentResult[];

  /** Messages specific to this agent */
  messages: Message[];

  /** Tool call history */
  toolHistory: ToolCallRecord[];

  /** Timestamps */
  createdAt: number;
  lastActivityAt: number;

  /** Custom context data */
  context?: Record<string, unknown>;
}

/**
 * Tool call record for history
 */
export interface ToolCallRecord {
  /** Tool name */
  tool: string;

  /** Tool arguments */
  arguments: Record<string, unknown>;

  /** Result */
  result?: string;

  /** Success status */
  success: boolean;

  /** Timestamp */
  timestamp: number;
}

/**
 * Session index entry
 */
export interface SessionIndexEntry {
  sessionId: string;
  createdAt: number;
  savedAt: number;
  workingDirectory: string;
  mainAgentId: string;
  state: AgentInstanceState;
  messageCount: number;
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const SESSION_VERSION = 1;
const SESSION_DIR_NAME = 'agent-sessions';
const SESSION_INDEX_FILE = 'index.json';
const MAX_SESSIONS = 50; // Maximum sessions to keep

// ----------------------------------------------------------------------------
// Session Persistence Class
// ----------------------------------------------------------------------------

/**
 * Session Persistence Manager
 *
 * Handles saving and loading agent sessions to/from disk.
 * Enables cross-process recovery and session resumption.
 */
export class SessionPersistence {
  private baseDir: string;
  private sessionIndex: Map<string, SessionIndexEntry> = new Map();
  private initialized = false;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(os.homedir(), '.code-agent', SESSION_DIR_NAME);
  }

  /**
   * Initialize the persistence system
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure base directory exists
      await fs.promises.mkdir(this.baseDir, { recursive: true });

      // Load session index
      await this.loadIndex();

      this.initialized = true;
      logger.info('Session persistence initialized', { baseDir: this.baseDir });
    } catch (error) {
      logger.error('Failed to initialize session persistence', { error });
      throw error;
    }
  }

  /**
   * Save a session to disk
   */
  async saveSession(session: PersistedSession): Promise<void> {
    await this.ensureInitialized();

    const sessionPath = this.getSessionPath(session.sessionId);

    try {
      // Update save timestamp
      session.savedAt = Date.now();

      // Write session file
      await fs.promises.writeFile(
        sessionPath,
        JSON.stringify(session, null, 2),
        'utf-8'
      );

      // Update index
      this.sessionIndex.set(session.sessionId, {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        savedAt: session.savedAt,
        workingDirectory: session.workingDirectory,
        mainAgentId: session.mainAgent.agentId,
        state: session.mainAgent.state,
        messageCount: session.messages.length,
      });

      await this.saveIndex();

      logger.debug('Session saved', { sessionId: session.sessionId });
    } catch (error) {
      logger.error('Failed to save session', { sessionId: session.sessionId, error });
      throw error;
    }
  }

  /**
   * Load a session from disk
   */
  async loadSession(sessionId: string): Promise<PersistedSession | null> {
    await this.ensureInitialized();

    const sessionPath = this.getSessionPath(sessionId);

    try {
      // 异步检查文件是否存在（性能优化：避免 sync I/O 阻塞主进程）
      try {
        await fs.promises.access(sessionPath, fs.constants.F_OK);
      } catch {
        logger.debug('Session not found', { sessionId });
        return null;
      }

      const content = await fs.promises.readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content) as PersistedSession;

      // Version migration if needed
      if (session.version < SESSION_VERSION) {
        return this.migrateSession(session);
      }

      logger.debug('Session loaded', { sessionId });
      return session;
    } catch (error) {
      logger.error('Failed to load session', { sessionId, error });
      return null;
    }
  }

  /**
   * Delete a session from disk
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    await this.ensureInitialized();

    const sessionPath = this.getSessionPath(sessionId);

    try {
      // 异步删除文件（性能优化：避免 sync I/O 阻塞主进程）
      await fs.promises.unlink(sessionPath).catch((err) => {
        // ENOENT 表示文件不存在，不是错误
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      });

      this.sessionIndex.delete(sessionId);
      await this.saveIndex();

      logger.debug('Session deleted', { sessionId });
      return true;
    } catch (error) {
      logger.error('Failed to delete session', { sessionId, error });
      return false;
    }
  }

  /**
   * List all saved sessions
   */
  async listSessions(): Promise<SessionIndexEntry[]> {
    await this.ensureInitialized();

    return Array.from(this.sessionIndex.values())
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Find sessions by working directory
   */
  async findByWorkingDirectory(workingDir: string): Promise<SessionIndexEntry[]> {
    await this.ensureInitialized();

    const normalizedPath = path.resolve(workingDir);
    return Array.from(this.sessionIndex.values())
      .filter(entry => path.resolve(entry.workingDirectory) === normalizedPath)
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Find resumable sessions (paused or running)
   */
  async findResumable(): Promise<SessionIndexEntry[]> {
    await this.ensureInitialized();

    const resumableStates: AgentInstanceState[] = [
      'paused',
      'running',
      'waiting_permission',
      'waiting_user',
    ];

    return Array.from(this.sessionIndex.values())
      .filter(entry => resumableStates.includes(entry.state))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Clean up old sessions beyond the limit
   */
  async cleanup(): Promise<number> {
    await this.ensureInitialized();

    const sessions = await this.listSessions();
    if (sessions.length <= MAX_SESSIONS) {
      return 0;
    }

    // Remove oldest sessions beyond the limit
    const toRemove = sessions.slice(MAX_SESSIONS);
    let removed = 0;

    for (const entry of toRemove) {
      if (await this.deleteSession(entry.sessionId)) {
        removed++;
      }
    }

    logger.info('Cleaned up old sessions', { removed });
    return removed;
  }

  /**
   * Create a new persisted session from agent instance
   */
  createPersistedSession(
    sessionId: string,
    mainAgent: AgentInstance,
    messages: Message[],
    workingDirectory: string
  ): PersistedSession {
    return {
      version: SESSION_VERSION,
      sessionId,
      mainAgent: this.createPersistedAgentInstance(mainAgent, messages),
      subAgents: [],
      messages,
      workingDirectory,
      createdAt: mainAgent.createdAt,
      savedAt: Date.now(),
    };
  }

  /**
   * Create a persisted agent instance
   */
  createPersistedAgentInstance(
    agent: AgentInstance,
    messages: Message[]
  ): PersistedAgentInstance {
    return {
      instanceId: agent.instanceId,
      agentId: agent.agentId,
      parentInstanceId: agent.parentInstanceId,
      state: agent.state,
      permissionMode: agent.permissionMode,
      currentIteration: agent.currentIteration,
      task: agent.task,
      subagentResults: agent.subagentResults,
      messages,
      toolHistory: [], // To be populated by caller
      createdAt: agent.createdAt,
      lastActivityAt: agent.lastActivityAt,
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`);
  }

  private getIndexPath(): string {
    return path.join(this.baseDir, SESSION_INDEX_FILE);
  }

  private async loadIndex(): Promise<void> {
    const indexPath = this.getIndexPath();

    try {
      // 异步检查并加载索引文件（性能优化：避免 sync I/O 阻塞主进程）
      const content = await fs.promises.readFile(indexPath, 'utf-8').catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null; // 文件不存在，返回 null
        }
        throw err;
      });

      if (content) {
        const entries = JSON.parse(content) as SessionIndexEntry[];

        this.sessionIndex.clear();
        for (const entry of entries) {
          this.sessionIndex.set(entry.sessionId, entry);
        }

        logger.debug('Session index loaded', { count: entries.length });
      }
    } catch (error) {
      logger.warn('Failed to load session index, starting fresh', { error });
      this.sessionIndex.clear();
    }
  }

  private async saveIndex(): Promise<void> {
    const indexPath = this.getIndexPath();
    const entries = Array.from(this.sessionIndex.values());

    try {
      await fs.promises.writeFile(
        indexPath,
        JSON.stringify(entries, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.error('Failed to save session index', { error });
    }
  }

  private migrateSession(session: PersistedSession): PersistedSession {
    // Handle version migrations here
    logger.info('Migrating session', {
      sessionId: session.sessionId,
      fromVersion: session.version,
      toVersion: SESSION_VERSION,
    });

    // Currently no migrations needed, just update version
    session.version = SESSION_VERSION;
    return session;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let sessionPersistenceInstance: SessionPersistence | null = null;

/**
 * Get or create session persistence instance
 */
export function getSessionPersistence(): SessionPersistence {
  if (!sessionPersistenceInstance) {
    sessionPersistenceInstance = new SessionPersistence();
  }
  return sessionPersistenceInstance;
}

/**
 * Reset session persistence instance (for testing)
 */
export function resetSessionPersistence(): void {
  sessionPersistenceInstance = null;
}
