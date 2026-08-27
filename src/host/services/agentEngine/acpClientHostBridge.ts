// ============================================================================
// ACP client 侧必答方法 = Neo 的执行面与审批闸
// ============================================================================
//
// 🔴 这是本条路上唯一的安全边界，读之前先记住 2026-08-27 抓包实证的事实：
// **ACP agent 自己不执行任何副作用。** Kimi 0.38.0 写文件走 `fs/write_text_file`、
// 跑命令走 `terminal/create`（params 里是完整的 `/bin/bash -c "cd '<cwd>' && …"`），
// 四轮 prompt 里 `session/request_permission` 一次都没发过。
//
// ⇒ 「批准与否」不在 agent 手里，在这里。本文件每个方法都必须自己问过 Neo 的审批链
// 才动手；`requestPermission` 缺席时一律拒（fail-closed）——没有审批口不等于免审批。
//
// 复用的是 orchestrator 那条既有链（permission_request 事件 → 审批卡 → handlePermissionResponse），
// 不新起第二套通道：批不批由用户已有的权限预设决定，这里不自造策略。

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ExternalEnginePermissionAsk,
} from '../../../shared/contract/agentEngine';
import { PermissionRequestReason } from '../../../shared/contract/permission';
import { createLogger } from '../infra/logger';

const logger = createLogger('AcpClientHostBridge');

/** terminal/create 默认保留的输出上限；ACP 允许 agent 用 outputByteLimit 收紧。 */
const DEFAULT_TERMINAL_OUTPUT_BYTES = 256 * 1024;

export interface AcpHostBridgeOptions {
  /** 会话工作区根；所有路径判定以它为准。 */
  workspaceRoot: string;
  /** 本次运行的 cwd（已过 assertWorkspaceCwd）。 */
  cwd: string;
  sessionId: string;
  /** Neo 现有审批链；缺省即 fail-closed。 */
  requestPermission?: ExternalEnginePermissionAsk;
  /** 供适配器把「拒绝」记进台账/日志。 */
  onDenied?: (what: string, detail: string) => void;
  /** 供适配器把「已放行的副作用」记进台账。 */
  onAllowed?: (what: string, detail: string) => void;
}

interface TerminalRecord {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  byteLimit: number;
  exitCode: number | null;
  signal: string | null;
  exited: Promise<void>;
}

/** ACP 要求 client 抛出的失败以 JSON-RPC error 返回；用普通 Error 即可，SDK 会包装。 */
class AcpPermissionDeniedError extends Error {
  constructor(what: string) {
    super(`Neo denied this ${what}. The user did not approve it.`);
    this.name = 'AcpPermissionDeniedError';
  }
}

export class AcpClientHostBridge {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(private readonly options: AcpHostBridgeOptions) {}

  /** 路径是否落在工作区内。用 path.relative 判，不用字符串前缀（`/ws-evil` 会前缀命中 `/ws`）。 */
  private isInsideWorkspace(target: string): boolean {
    const rel = path.relative(this.options.workspaceRoot, path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * 问一次 Neo 审批链。
   * 🔴 fail-closed 的两条路都在这：没有审批口 → 拒；审批链自己抛错 → 拒。
   */
  private async ask(input: {
    what: string;
    type: 'file_read' | 'file_write' | 'command';
    tool: string;
    details: Record<string, unknown>;
    reasonCode: PermissionRequestReason;
    dangerLevel?: 'normal' | 'warning' | 'danger';
  }): Promise<boolean> {
    const { requestPermission } = this.options;
    if (!requestPermission) {
      logger.warn(`[ACP] 无审批口，${input.what} 按 fail-closed 拒绝`, { tool: input.tool });
      this.options.onDenied?.(input.what, 'no approval channel (fail-closed)');
      return false;
    }
    try {
      const result = await requestPermission({
        sessionId: this.options.sessionId,
        type: input.type,
        tool: input.tool,
        details: input.details,
        reasonCode: input.reasonCode,
        ...(input.dangerLevel ? { dangerLevel: input.dangerLevel } : {}),
      });
      if (!result.approved) {
        this.options.onDenied?.(input.what, result.denialSource ?? 'user');
        return false;
      }
      this.options.onAllowed?.(input.what, input.tool);
      return true;
    } catch (error) {
      // 审批链本身炸了不能当成放行：这正是 fail-closed 存在的理由。
      logger.error(`[ACP] 审批链异常，${input.what} 按 fail-closed 拒绝`, error);
      this.options.onDenied?.(input.what, 'approval channel error (fail-closed)');
      return false;
    }
  }

  // --- fs/read_text_file -----------------------------------------------------
  async readTextFile(params: { path: string; line?: number | null; limit?: number | null }): Promise<{ content: string }> {
    const target = path.resolve(this.options.cwd, params.path);
    // 工作区内的读走既有只读语义直接放行；跨出工作区才是信任边界，必须问。
    if (!this.isInsideWorkspace(target)) {
      const approved = await this.ask({
        what: 'file read outside the workspace',
        type: 'file_read',
        tool: 'acp:fs/read_text_file',
        details: { path: target, filePath: target },
        reasonCode: PermissionRequestReason.Unknown,
        dangerLevel: 'warning',
      });
      if (!approved) throw new AcpPermissionDeniedError('file read');
    }
    const raw = await fs.readFile(target, 'utf8');
    if (typeof params.line !== 'number' && typeof params.limit !== 'number') {
      return { content: raw };
    }
    const lines = raw.split('\n');
    const start = Math.max(1, params.line ?? 1) - 1;
    const end = typeof params.limit === 'number' ? start + params.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  // --- fs/write_text_file ----------------------------------------------------
  async writeTextFile(params: { path: string; content: string }): Promise<void> {
    const target = path.resolve(this.options.cwd, params.path);
    const outside = !this.isInsideWorkspace(target);
    const before = await fs.readFile(target, 'utf8').catch(() => undefined);
    const approved = await this.ask({
      what: 'file write',
      type: 'file_write',
      tool: 'acp:fs/write_text_file',
      details: {
        path: target,
        filePath: target,
        ...(before === undefined ? {} : { oldContent: before }),
        newContent: params.content,
        preview: {
          type: 'diff' as const,
          ...(before === undefined ? {} : { before }),
          after: params.content,
          summary: `${outside ? '工作区外' : '工作区内'}写入 ${path.basename(target)}`,
        },
      },
      reasonCode: outside
        ? PermissionRequestReason.FileWriteOutsideWorkspace
        : PermissionRequestReason.Unknown,
      dangerLevel: outside ? 'danger' : 'normal',
    });
    if (!approved) throw new AcpPermissionDeniedError('file write');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, params.content, 'utf8');
  }

  // --- terminal/* ------------------------------------------------------------
  async createTerminal(params: {
    command: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    cwd?: string | null;
    outputByteLimit?: number | null;
  }): Promise<{ terminalId: string }> {
    const commandLine = [params.command, ...(params.args ?? [])].join(' ');
    const approved = await this.ask({
      what: 'shell command',
      type: 'command',
      tool: 'acp:terminal/create',
      details: {
        command: commandLine,
        preview: { type: 'command' as const, summary: commandLine },
      },
      reasonCode: PermissionRequestReason.ShellHighRisk,
      dangerLevel: 'warning',
    });
    if (!approved) throw new AcpPermissionDeniedError('shell command');

    const cwd = params.cwd ? path.resolve(params.cwd) : this.options.cwd;
    if (!this.isInsideWorkspace(cwd)) {
      throw new Error('ACP terminal cwd must stay inside the session workspace.');
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of params.env ?? []) env[entry.name] = entry.value;

    const child = spawn(params.command, params.args ?? [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const terminalId = `acp-term-${randomUUID().slice(0, 8)}`;
    const record: TerminalRecord = {
      child,
      output: '',
      truncated: false,
      byteLimit: params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_BYTES,
      exitCode: null,
      signal: null,
      exited: new Promise<void>((resolve) => {
        child.on('close', (code, signal) => {
          record.exitCode = code;
          record.signal = signal ?? null;
          resolve();
        });
        child.on('error', (error) => {
          record.output += `\n${error.message}`;
          record.exitCode = record.exitCode ?? -1;
          resolve();
        });
      }),
    };
    const append = (chunk: Buffer) => {
      record.output += chunk.toString('utf8');
      // ACP 要求超限时从**开头**截断，且截在字符边界上。
      if (Buffer.byteLength(record.output, 'utf8') > record.byteLimit) {
        record.truncated = true;
        const buf = Buffer.from(record.output, 'utf8');
        record.output = buf.subarray(buf.byteLength - record.byteLimit).toString('utf8');
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  terminalOutput(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
    const record = this.requireTerminal(terminalId);
    return {
      output: record.output,
      truncated: record.truncated,
      ...(record.child.exitCode !== null || record.signal
        ? { exitStatus: { exitCode: record.exitCode, signal: record.signal } }
        : {}),
    };
  }

  async waitForTerminalExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const record = this.requireTerminal(terminalId);
    await record.exited;
    return { exitCode: record.exitCode, signal: record.signal };
  }

  killTerminal(terminalId: string): void {
    this.requireTerminal(terminalId).child.kill('SIGTERM');
  }

  releaseTerminal(terminalId: string): void {
    const record = this.terminals.get(terminalId);
    if (!record) return;
    if (record.child.exitCode === null) record.child.kill('SIGTERM');
    this.terminals.delete(terminalId);
  }

  /** 运行结束时收干净，别把子进程留成孤儿。 */
  disposeAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.releaseTerminal(terminalId);
  }

  private requireTerminal(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`Unknown ACP terminal ${terminalId}`);
    return record;
  }

  // --- session/request_permission --------------------------------------------
  /**
   * 协议要求 client 必答。Kimi 实测不用它，但别家用（例如自己执行工具的 agent），
   * 所以照实现：把 ACP 的选项翻成 Neo 的一次审批，拒绝时**优先选 agent 给的 reject 选项**，
   * 没有可选项才回 cancelled。
   */
  async requestToolPermission(params: {
    toolCall?: { title?: string; kind?: string; rawInput?: unknown };
    options?: Array<{ optionId: string; name: string; kind: string }>;
  }): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const title = params.toolCall?.title ?? 'tool call';
    const approved = await this.ask({
      what: `agent tool call (${title})`,
      type: params.toolCall?.kind === 'execute' ? 'command' : 'file_write',
      tool: `acp:${title}`,
      details: {
        toolName: title,
        preview: { type: 'generic' as const, summary: title },
      },
      reasonCode: params.toolCall?.kind === 'execute'
        ? PermissionRequestReason.ShellHighRisk
        : PermissionRequestReason.Unknown,
      dangerLevel: 'warning',
    });
    const options = params.options ?? [];
    const pick = (kinds: string[]) => options.find((option) => kinds.includes(option.kind))?.optionId;
    const chosen = approved
      ? pick(['allow_once', 'allow_always'])
      : pick(['reject_once', 'reject_always']);
    if (!chosen) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: chosen } };
  }
}
