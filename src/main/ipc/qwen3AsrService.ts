// ============================================================================
// Qwen3-ASR 常驻进程服务 — 模型只加载一次，stdin/stdout JSONL 协议通信
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('Qwen3AsrService');

const MAX_RESTART_ATTEMPTS = 3;
const READY_TIMEOUT_MS = 60000;
const TRANSCRIBE_TIMEOUT_MS = 30000;

interface PendingRequest {
  resolve: (value: { text: string; duration: number }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Qwen3AsrService {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private restartCount = 0;
  private running = false;
  private startPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async _start(): Promise<void> {
    const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'qwen3-asr-inference.py');

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('python3', [scriptPath, '--serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process = proc;

      const timeout = setTimeout(() => {
        reject(new Error('Qwen3-ASR serve mode: ready timeout (60s)'));
        this.kill();
      }, READY_TIMEOUT_MS);

      proc.stderr?.on('data', (data: Buffer) => {
        logger.warn('[Qwen3-ASR stderr]', data.toString().trim());
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.error('[Qwen3-ASR] Process error:', err.message);
        this.handleCrash();
        reject(err);
      });

      proc.on('exit', (code, signal) => {
        logger.info(`[Qwen3-ASR] Process exited: code=${code}, signal=${signal}`);
        this.running = false;
        this.rejectAllPending(new Error(`Process exited: code=${code}`));
        if (this.running) this.handleCrash();
      });

      this.rl = readline.createInterface({ input: proc.stdout! });

      // Wait for the first "ready" line
      const onFirstLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'ready') {
            clearTimeout(timeout);
            this.running = true;
            this.restartCount = 0;
            logger.info('[Qwen3-ASR] Serve mode ready, model:', msg.model_path);

            // Switch to normal message handling
            this.rl!.removeListener('line', onFirstLine);
            this.rl!.on('line', (l) => this.handleLine(l));

            resolve();
          } else if (msg.status === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.message || 'Qwen3-ASR startup error'));
            this.kill();
          }
        } catch {
          // ignore non-JSON lines during startup
        }
      };

      this.rl.on('line', onFirstLine);
    });
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      const id = msg.id as string;
      if (!id) return;

      const pending = this.pending.get(id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve({ text: msg.text || '', duration: msg.duration || 0 });
      }
    } catch {
      // ignore non-JSON output
    }
  }

  async transcribeChunk(wavPath: string): Promise<{ text: string; duration: number }> {
    if (!this.running || !this.process?.stdin) {
      throw new Error('Qwen3-ASR service not running');
    }

    const id = `req-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Transcribe timeout (${TRANSCRIBE_TIMEOUT_MS}ms): ${wavPath}`));
      }, TRANSCRIBE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const request = JSON.stringify({ id, audio_path: wavPath }) + '\n';
      this.process!.stdin!.write(request);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    this.running = false;

    // Send quit command
    try {
      this.process.stdin?.write(JSON.stringify({ command: 'quit' }) + '\n');
    } catch { /* stdin may be closed */ }

    // Wait briefly for graceful shutdown, then force kill
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        this.kill();
        resolve();
      }, 3000);

      this.process?.on('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
    });

    this.cleanup();
  }

  private kill(): void {
    try {
      this.process?.kill('SIGTERM');
    } catch { /* already dead */ }
    setTimeout(() => {
      try { this.process?.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
  }

  private cleanup(): void {
    this.rl?.close();
    this.rl = null;
    this.process = null;
    this.rejectAllPending(new Error('Service stopped'));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pending.clear();
  }

  private handleCrash(): void {
    this.cleanup();

    if (this.restartCount < MAX_RESTART_ATTEMPTS) {
      this.restartCount++;
      logger.warn(`[Qwen3-ASR] Crash detected, restarting (${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
      this.start().catch((err) => {
        logger.error('[Qwen3-ASR] Restart failed:', err.message);
      });
    } else {
      logger.error('[Qwen3-ASR] Max restart attempts reached, giving up');
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Singleton
let instance: Qwen3AsrService | null = null;

export function getQwen3AsrService(): Qwen3AsrService {
  if (!instance) {
    instance = new Qwen3AsrService();
  }
  return instance;
}
