// ============================================================================
// PTY Executor - Manages pseudo-terminal sessions for interactive commands
// ============================================================================

import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Constants
// ============================================================================

const MAX_PTY_SESSIONS = 10;
const MAX_PTY_OUTPUT = 1024 * 1024; // 1MB per session
const PTY_DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const PTY_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

// ============================================================================
// Types
// ============================================================================

export interface PtySessionState {
  sessionId: string;
  pty: pty.IPty;
  output: string[];
  outputFile: string;
  outputStream?: fs.WriteStream;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  maxRuntime: number;
  outputSize: number;
  command: string;
  args: string[];
  exitCode?: number;
  lastReadPosition: number;
  timeout?: NodeJS.Timeout;
  cwd: string;
  cols: number;
  rows: number;
  inputBuffer: string[];
}

export interface PtySessionInfo {
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  command: string;
  args: string[];
  startTime: number;
  endTime?: number;
  duration: number;
  exitCode?: number;
  outputFile: string;
  cols: number;
  rows: number;
}

export interface PtySessionOutput {
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  output: string;
  exitCode?: number;
  duration: number;
}

// ============================================================================
// Session Storage
// ============================================================================

const ptySessions: Map<string, PtySessionState> = new Map();

// ============================================================================
// Directory Management
// ============================================================================

function getPtyDir(): string {
  const ptyDir = path.join(os.homedir(), '.code-agent', 'pty');
  if (!fs.existsSync(ptyDir)) {
    fs.mkdirSync(ptyDir, { recursive: true });
  }
  return ptyDir;
}

function getPtyOutputPath(sessionId: string): string {
  return path.join(getPtyDir(), `${sessionId}.log`);
}

// ============================================================================
// PTY Session Lifecycle
// ============================================================================

/**
 * Create a new PTY session
 */
export function createPtySession(options: {
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  maxRuntime?: number;
}): { success: boolean; sessionId?: string; error?: string; outputFile?: string } {
  // Check session limit
  if (ptySessions.size >= MAX_PTY_SESSIONS) {
    const cleaned = cleanupCompletedPtySessions();
    if (cleaned === 0 && ptySessions.size >= MAX_PTY_SESSIONS) {
      return {
        success: false,
        error: `Maximum number of PTY sessions (${MAX_PTY_SESSIONS}) reached. Use process_kill to terminate some sessions.`,
      };
    }
  }

  const sessionId = uuidv4();
  const outputFile = getPtyOutputPath(sessionId);

  const {
    command,
    args = [],
    cwd,
    cols = 80,
    rows = 24,
    env = {},
    maxRuntime = PTY_DEFAULT_TIMEOUT,
  } = options;

  try {
    // Determine shell based on platform
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';

    // Create PTY process
    const ptyProcess = pty.spawn(shell, ['-c', `${command} ${args.join(' ')}`].filter(Boolean), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        ...env,
        TERM: 'xterm-256color',
      } as Record<string, string>,
    });

    // Create output file stream
    const outputStream = fs.createWriteStream(outputFile, { flags: 'w' });

    const sessionState: PtySessionState = {
      sessionId,
      pty: ptyProcess,
      output: [],
      outputFile,
      outputStream,
      status: 'running',
      startTime: Date.now(),
      maxRuntime: Math.min(maxRuntime, PTY_DEFAULT_TIMEOUT),
      outputSize: 0,
      command,
      args,
      lastReadPosition: 0,
      cwd,
      cols,
      rows,
      inputBuffer: [],
    };

    // Set timeout for max runtime
    const timeout = setTimeout(() => {
      if (sessionState.status === 'running') {
        console.warn(`[PTY] Session ${sessionId} exceeded max runtime, terminating...`);
        try {
          ptyProcess.kill();
        } catch (err) {
          console.error(`[PTY] Failed to kill session ${sessionId}:`, err);
        }
      }
    }, sessionState.maxRuntime);

    sessionState.timeout = timeout;

    // Handle PTY data
    ptyProcess.onData((data) => {
      sessionState.outputSize += data.length;

      // Write to file
      sessionState.outputStream?.write(data);

      // Store in memory (with limit)
      if (sessionState.outputSize < MAX_PTY_OUTPUT) {
        sessionState.output.push(data);
      } else if (!sessionState.output[sessionState.output.length - 1]?.includes('[Output limit reached]')) {
        sessionState.output.push('[Output limit reached - further output written to file only]\n');
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      sessionState.status = exitCode === 0 ? 'completed' : 'failed';
      sessionState.exitCode = exitCode;
      sessionState.endTime = Date.now();

      if (sessionState.timeout) {
        clearTimeout(sessionState.timeout);
      }

      // Close output stream
      sessionState.outputStream?.end();
    });

    ptySessions.set(sessionId, sessionState);

    return {
      success: true,
      sessionId,
      outputFile,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: `Failed to create PTY session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Write input to a PTY session
 */
export function writeToPtySession(sessionId: string, data: string): { success: boolean; error?: string } {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  if (session.status !== 'running') {
    return { success: false, error: `PTY session ${sessionId} is not running (status: ${session.status})` };
  }

  try {
    session.pty.write(data);
    session.inputBuffer.push(data);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: `Failed to write to PTY: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Submit input to a PTY session (write + newline)
 */
export function submitToPtySession(sessionId: string, input: string): { success: boolean; error?: string } {
  return writeToPtySession(sessionId, input + '\n');
}

/**
 * Resize a PTY session
 */
export function resizePtySession(sessionId: string, cols: number, rows: number): { success: boolean; error?: string } {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  if (session.status !== 'running') {
    return { success: false, error: `PTY session ${sessionId} is not running` };
  }

  try {
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: `Failed to resize PTY: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Kill a PTY session
 */
export function killPtySession(sessionId: string): { success: boolean; error?: string; message?: string } {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  try {
    session.pty.kill();
    session.outputStream?.end();

    // Update status
    session.status = 'failed';
    session.endTime = Date.now();

    if (session.timeout) {
      clearTimeout(session.timeout);
    }

    return {
      success: true,
      message: `Successfully killed PTY session: ${sessionId} (${session.command})`,
    };
  } catch (error: unknown) {
    return { success: false, error: `Failed to kill PTY session: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Get PTY session output
 */
export function getPtySessionOutput(
  sessionId: string,
  block: boolean = false,
  timeout: number = 30000
): Promise<PtySessionOutput | null> {
  return new Promise(async (resolve) => {
    const session = ptySessions.get(sessionId);
    if (!session) {
      resolve(null);
      return;
    }

    // If blocking and still running, wait
    if (block && session.status === 'running') {
      const startTime = Date.now();

      while (session.status === 'running' && Date.now() - startTime < timeout) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const output = session.output.join('');
    const duration = (session.endTime || Date.now()) - session.startTime;

    resolve({
      sessionId,
      status: session.status,
      output,
      exitCode: session.exitCode,
      duration,
    });
  });
}

/**
 * Poll PTY session for new output since last read
 */
export function pollPtySession(sessionId: string): {
  success: boolean;
  data?: string;
  status?: 'running' | 'completed' | 'failed';
  exitCode?: number;
  error?: string;
} {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  const fullOutput = session.output.join('');
  const newData = fullOutput.substring(session.lastReadPosition);
  session.lastReadPosition = fullOutput.length;

  return {
    success: true,
    data: newData,
    status: session.status,
    exitCode: session.exitCode,
  };
}

/**
 * Get PTY session log from file
 */
export function getPtySessionLog(sessionId: string, tail?: number): {
  success: boolean;
  log?: string;
  error?: string;
} {
  const session = ptySessions.get(sessionId);
  if (!session) {
    // Try to read from file directly if session was cleaned up
    const logPath = getPtyOutputPath(sessionId);
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, 'utf-8');
        if (tail && tail > 0) {
          const lines = content.split('\n');
          return { success: true, log: lines.slice(-tail).join('\n') };
        }
        return { success: true, log: content };
      } catch (error: unknown) {
        return { success: false, error: `Failed to read log file: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  try {
    const content = fs.readFileSync(session.outputFile, 'utf-8');
    if (tail && tail > 0) {
      const lines = content.split('\n');
      return { success: true, log: lines.slice(-tail).join('\n') };
    }
    return { success: true, log: content };
  } catch (error: unknown) {
    return { success: false, error: `Failed to read log file: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Get all PTY sessions info
 */
export function getAllPtySessions(): PtySessionInfo[] {
  const result: PtySessionInfo[] = [];

  for (const [sessionId, session] of ptySessions) {
    result.push({
      sessionId,
      status: session.status,
      command: session.command,
      args: session.args,
      startTime: session.startTime,
      endTime: session.endTime,
      duration: (session.endTime || Date.now()) - session.startTime,
      exitCode: session.exitCode,
      outputFile: session.outputFile,
      cols: session.cols,
      rows: session.rows,
    });
  }

  return result;
}

/**
 * Get a specific PTY session
 */
export function getPtySession(sessionId: string): PtySessionState | undefined {
  return ptySessions.get(sessionId);
}

/**
 * Check if a session ID exists
 */
export function isPtySessionId(sessionId: string): boolean {
  return ptySessions.has(sessionId);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Cleanup completed PTY sessions (remove from memory, keep files)
 */
export function cleanupCompletedPtySessions(): number {
  let cleaned = 0;

  for (const [sessionId, session] of ptySessions) {
    if (session.status !== 'running') {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      session.outputStream?.end();
      ptySessions.delete(sessionId);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Cleanup timed out PTY sessions
 */
export function cleanupTimedOutPtySessions(): void {
  const now = Date.now();

  for (const [sessionId, session] of ptySessions) {
    if (session.status === 'running' && now - session.startTime > session.maxRuntime) {
      console.warn(`[PTY] Session ${sessionId} timed out, killing...`);
      killPtySession(sessionId);
    }
  }
}

// Start periodic cleanup
setInterval(() => {
  cleanupTimedOutPtySessions();
}, PTY_CLEANUP_INTERVAL);

// ============================================================================
// Persistence
// ============================================================================

interface PersistedPtySession {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  startTime: number;
  outputFile: string;
  status: 'running' | 'completed' | 'failed';
}

const PTY_PERSISTENCE_FILE = path.join(os.homedir(), '.code-agent', 'pty-sessions.json');

/**
 * Save running PTY sessions for recovery
 */
export function persistRunningPtySessions(): void {
  const sessions: PersistedPtySession[] = [];

  for (const [, session] of ptySessions) {
    if (session.status === 'running') {
      sessions.push({
        sessionId: session.sessionId,
        command: session.command,
        args: session.args,
        cwd: session.cwd,
        startTime: session.startTime,
        outputFile: session.outputFile,
        status: session.status,
      });
    }
  }

  try {
    const dir = path.dirname(PTY_PERSISTENCE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PTY_PERSISTENCE_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error('[PTY] Failed to persist sessions:', err);
  }
}

/**
 * Load persisted PTY sessions (called on startup)
 * Note: These sessions are marked as 'failed' since the original process is gone
 */
export function loadPersistedPtySessions(): PersistedPtySession[] {
  try {
    if (fs.existsSync(PTY_PERSISTENCE_FILE)) {
      const data = fs.readFileSync(PTY_PERSISTENCE_FILE, 'utf-8');
      const sessions: PersistedPtySession[] = JSON.parse(data);

      // Mark all as failed since the process is gone
      return sessions.map((s) => ({ ...s, status: 'failed' as const }));
    }
  } catch (err) {
    console.error('[PTY] Failed to load persisted sessions:', err);
  }
  return [];
}

/**
 * Clear persistence file
 */
export function clearPersistedPtySessions(): void {
  try {
    if (fs.existsSync(PTY_PERSISTENCE_FILE)) {
      fs.unlinkSync(PTY_PERSISTENCE_FILE);
    }
  } catch (err) {
    console.error('[PTY] Failed to clear persisted sessions:', err);
  }
}

// Persist sessions on process exit
process.on('beforeExit', persistRunningPtySessions);
process.on('SIGINT', () => {
  persistRunningPtySessions();
});
process.on('SIGTERM', () => {
  persistRunningPtySessions();
});
