// ============================================================================
// Session Fork - Create branching conversation paths
// ============================================================================
// Enables forking sessions at any point to explore alternative paths:
// - Fork from any message in history
// - Preserve full context up to fork point
// - Track fork relationships (parent/children)
// - Support branch merging strategies
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';

const logger = createLogger('SessionFork');

/**
 * Fork metadata
 */
export interface ForkMetadata {
  /** ID of the parent session */
  parentSessionId: string;
  /** Index of the message where fork occurred */
  forkPointIndex: number;
  /** Message ID at fork point */
  forkPointMessageId: string;
  /** Timestamp of fork creation */
  forkedAt: number;
  /** User-provided reason for forking */
  forkReason?: string;
}

/**
 * Session with fork information
 */
export interface ForkedSession extends CachedSession {
  /** Fork metadata (only present if this is a forked session) */
  fork?: ForkMetadata;
  /** IDs of child sessions forked from this one */
  childForks?: string[];
}

/**
 * Fork options
 */
export interface ForkOptions {
  /** Message index to fork from (default: last message) */
  fromMessageIndex?: number;
  /** Message ID to fork from (alternative to index) */
  fromMessageId?: string;
  /** Include messages after fork point */
  includeAfterForkPoint?: boolean;
  /** Reason for forking */
  reason?: string;
  /** New session ID (auto-generated if not provided) */
  newSessionId?: string;
  /** Initial message to add to forked session */
  initialMessage?: CachedMessage;
}

/**
 * Fork result
 */
export interface ForkResult {
  /** Whether fork was successful */
  success: boolean;
  /** The forked session */
  forkedSession?: ForkedSession;
  /** Error message if failed */
  error?: string;
  /** Fork statistics */
  stats?: {
    /** Messages preserved from original */
    messagesPreserved: number;
    /** Messages excluded */
    messagesExcluded: number;
    /** Tokens in forked session */
    tokenCount: number;
  };
}

/**
 * Generate a unique session ID for forks
 */
function generateForkId(parentId: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${parentId}-fork-${timestamp}-${random}`;
}

/**
 * Fork a session at a specific point
 */
export function forkSession(
  sourceSession: CachedSession,
  options: ForkOptions = {}
): ForkResult {
  const {
    fromMessageIndex,
    fromMessageId,
    includeAfterForkPoint = false,
    reason,
    newSessionId,
    initialMessage,
  } = options;

  try {
    // Determine fork point
    let forkIndex: number;

    if (fromMessageId !== undefined) {
      forkIndex = sourceSession.messages.findIndex(m => m.id === fromMessageId);
      if (forkIndex === -1) {
        return {
          success: false,
          error: `Message with ID "${fromMessageId}" not found in session`,
        };
      }
    } else if (fromMessageIndex !== undefined) {
      if (fromMessageIndex < 0 || fromMessageIndex >= sourceSession.messages.length) {
        return {
          success: false,
          error: `Invalid message index: ${fromMessageIndex}. Session has ${sourceSession.messages.length} messages.`,
        };
      }
      forkIndex = fromMessageIndex;
    } else {
      // Default to last message
      forkIndex = sourceSession.messages.length - 1;
    }

    // Copy messages up to (and optionally including/after) fork point
    const endIndex = includeAfterForkPoint
      ? sourceSession.messages.length
      : forkIndex + 1;

    const forkedMessages = sourceSession.messages
      .slice(0, endIndex)
      .map(msg => ({ ...msg })); // Deep copy

    // Calculate token count
    const tokenCount = forkedMessages.reduce((sum, m) => sum + (m.tokens || 0), 0);

    // Create fork metadata
    const forkMetadata: ForkMetadata = {
      parentSessionId: sourceSession.sessionId,
      forkPointIndex: forkIndex,
      forkPointMessageId: sourceSession.messages[forkIndex].id,
      forkedAt: Date.now(),
      forkReason: reason,
    };

    // Create forked session
    const forkedSession: ForkedSession = {
      sessionId: newSessionId || generateForkId(sourceSession.sessionId),
      messages: forkedMessages,
      startedAt: sourceSession.startedAt,
      lastActivityAt: Date.now(),
      totalTokens: tokenCount,
      metadata: {
        ...sourceSession.metadata,
        forkedFrom: sourceSession.sessionId,
      },
      fork: forkMetadata,
    };

    // Add initial message if provided
    if (initialMessage) {
      forkedSession.messages.push(initialMessage);
      forkedSession.totalTokens += initialMessage.tokens || 0;
    }

    logger.debug('Session forked', {
      parentId: sourceSession.sessionId,
      forkId: forkedSession.sessionId,
      forkIndex,
      messagesPreserved: forkedMessages.length,
    });

    return {
      success: true,
      forkedSession,
      stats: {
        messagesPreserved: forkedMessages.length,
        messagesExcluded: sourceSession.messages.length - endIndex,
        tokenCount: forkedSession.totalTokens,
      },
    };
  } catch (error: any) {
    logger.error('Failed to fork session', { error });
    return {
      success: false,
      error: error.message || 'Unknown error during fork',
    };
  }
}

/**
 * Fork and save to cache
 */
export function forkAndSave(
  sourceSessionId: string,
  options: ForkOptions = {},
  cache: SessionLocalCache = getDefaultCache()
): ForkResult {
  // Get source session
  const sourceSession = cache.getSession(sourceSessionId);
  if (!sourceSession) {
    return {
      success: false,
      error: `Session "${sourceSessionId}" not found`,
    };
  }

  // Fork the session
  const result = forkSession(sourceSession, options);

  if (result.success && result.forkedSession) {
    // Save forked session to cache
    cache.setSession(result.forkedSession);

    // Update parent session with child fork reference
    const updatedParent = cache.getSession(sourceSessionId);
    if (updatedParent) {
      const forkedParent = updatedParent as ForkedSession;
      if (!forkedParent.childForks) {
        forkedParent.childForks = [];
      }
      forkedParent.childForks.push(result.forkedSession.sessionId);
      cache.setSession(forkedParent);
    }
  }

  return result;
}

/**
 * Get fork tree for a session
 */
export interface ForkTreeNode {
  sessionId: string;
  forkMetadata?: ForkMetadata;
  children: ForkTreeNode[];
  messageCount: number;
  lastActivity: number;
}

/**
 * Build fork tree starting from a session
 */
export function buildForkTree(
  sessionId: string,
  cache: SessionLocalCache = getDefaultCache()
): ForkTreeNode | null {
  const session = cache.getSession(sessionId) as ForkedSession | undefined;
  if (!session) {
    return null;
  }

  const node: ForkTreeNode = {
    sessionId: session.sessionId,
    forkMetadata: session.fork,
    children: [],
    messageCount: session.messages.length,
    lastActivity: session.lastActivityAt,
  };

  // Recursively build children
  if (session.childForks && session.childForks.length > 0) {
    for (const childId of session.childForks) {
      const childNode = buildForkTree(childId, cache);
      if (childNode) {
        node.children.push(childNode);
      }
    }
  }

  return node;
}

/**
 * Find the root session of a fork tree
 */
export function findRootSession(
  sessionId: string,
  cache: SessionLocalCache = getDefaultCache()
): string | null {
  let currentId = sessionId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentId)) {
      // Circular reference detected
      logger.warn('Circular fork reference detected', { sessionId: currentId });
      return null;
    }
    visited.add(currentId);

    const session = cache.getSession(currentId) as ForkedSession | undefined;
    if (!session) {
      return null;
    }

    if (!session.fork || !session.fork.parentSessionId) {
      // This is the root
      return currentId;
    }

    currentId = session.fork.parentSessionId;
  }
}

/**
 * Get all forks of a session (direct children only)
 */
export function getDirectForks(
  sessionId: string,
  cache: SessionLocalCache = getDefaultCache()
): ForkedSession[] {
  const session = cache.getSession(sessionId) as ForkedSession | undefined;
  if (!session || !session.childForks) {
    return [];
  }

  return session.childForks
    .map(id => cache.getSession(id) as ForkedSession | undefined)
    .filter((s): s is ForkedSession => s !== undefined);
}

/**
 * Get fork history (path from root to current session)
 */
export function getForkHistory(
  sessionId: string,
  cache: SessionLocalCache = getDefaultCache()
): ForkMetadata[] {
  const history: ForkMetadata[] = [];
  let currentId = sessionId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    const session = cache.getSession(currentId) as ForkedSession | undefined;
    if (!session || !session.fork) {
      break;
    }

    history.unshift(session.fork);
    currentId = session.fork.parentSessionId;
  }

  return history;
}

/**
 * Delete a fork and optionally its children
 */
export function deleteFork(
  sessionId: string,
  deleteChildren: boolean = false,
  cache: SessionLocalCache = getDefaultCache()
): { deleted: string[]; errors: string[] } {
  const deleted: string[] = [];
  const errors: string[] = [];

  const session = cache.getSession(sessionId) as ForkedSession | undefined;
  if (!session) {
    errors.push(`Session "${sessionId}" not found`);
    return { deleted, errors };
  }

  // Delete children first if requested
  if (deleteChildren && session.childForks) {
    for (const childId of session.childForks) {
      const childResult = deleteFork(childId, true, cache);
      deleted.push(...childResult.deleted);
      errors.push(...childResult.errors);
    }
  }

  // Remove reference from parent
  if (session.fork && session.fork.parentSessionId) {
    const parent = cache.getSession(session.fork.parentSessionId) as ForkedSession | undefined;
    if (parent && parent.childForks) {
      parent.childForks = parent.childForks.filter(id => id !== sessionId);
      cache.setSession(parent);
    }
  }

  // Delete the session
  if (cache.deleteSession(sessionId)) {
    deleted.push(sessionId);
  } else {
    errors.push(`Failed to delete session "${sessionId}"`);
  }

  return { deleted, errors };
}

/**
 * Session Fork Manager class
 */
export class SessionForkManager {
  private cache: SessionLocalCache;

  constructor(cache?: SessionLocalCache) {
    this.cache = cache || getDefaultCache();
  }

  /**
   * Fork a session
   */
  fork(sessionId: string, options?: ForkOptions): ForkResult {
    return forkAndSave(sessionId, options, this.cache);
  }

  /**
   * Get fork tree
   */
  getTree(sessionId: string): ForkTreeNode | null {
    return buildForkTree(sessionId, this.cache);
  }

  /**
   * Get fork history
   */
  getHistory(sessionId: string): ForkMetadata[] {
    return getForkHistory(sessionId, this.cache);
  }

  /**
   * Find root session
   */
  findRoot(sessionId: string): string | null {
    return findRootSession(sessionId, this.cache);
  }

  /**
   * Get direct forks
   */
  getForks(sessionId: string): ForkedSession[] {
    return getDirectForks(sessionId, this.cache);
  }

  /**
   * Delete a fork
   */
  delete(sessionId: string, deleteChildren?: boolean): { deleted: string[]; errors: string[] } {
    return deleteFork(sessionId, deleteChildren, this.cache);
  }
}

/**
 * Default fork manager instance
 */
let defaultForkManager: SessionForkManager | null = null;

export function getDefaultForkManager(): SessionForkManager {
  if (!defaultForkManager) {
    defaultForkManager = new SessionForkManager();
  }
  return defaultForkManager;
}
