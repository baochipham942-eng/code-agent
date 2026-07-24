// ============================================================================
// LSP Server Manager - Language Server Protocol Integration
// ============================================================================
// A simplified LSP manager for Code Agent
// Features:
// - Support for TypeScript and Python language servers
// - Auto-detection of installed servers
// - Basic LSP operations (definition, references, hover, symbols)
// ============================================================================

import { EventEmitter } from 'events';
import { spawn, ChildProcess, spawnSync } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getLanguageId } from './languages';
import { ensureInstalled, LSPInstallError, type LSPInstallSource } from './installer';

// ============================================================================
// Types
// ============================================================================

export interface LSPServerConfig {
  name: string;
  command: string;
  args?: string[];
  fileExtensions: string[];
  extensionToLanguage?: Record<string, string>;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  /** Optional installer; falls back to PATH if not configured */
  install?: LSPInstallSource;
}

export type LSPServerState = 'initializing' | 'ready' | 'error' | 'stopped';

export interface LSPDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

type LSPResultMessage = {
  kind: 'result';
  id: number;
  result: unknown;
};

type LSPErrorMessage = {
  kind: 'error';
  id: number;
  message: string;
};

type LSPNotificationMessage = {
  kind: 'notification';
  method: string;
  params: unknown;
};

type LSPIncomingMessage = LSPResultMessage | LSPErrorMessage | LSPNotificationMessage;

type LSPOutgoingMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
};

type DiagnosticsParams = {
  uri: string;
  diagnostics: LSPDiagnostic[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePosition(value: unknown): { line: number; character: number } | null {
  if (!isRecord(value)) {
    return null;
  }

  const line = readNumber(value.line);
  const character = readNumber(value.character);
  return line === undefined || character === undefined ? null : { line, character };
}

function normalizeDiagnostic(value: unknown): LSPDiagnostic | null {
  if (!isRecord(value) || !isRecord(value.range) || typeof value.message !== 'string') {
    return null;
  }

  const start = normalizePosition(value.range.start);
  const end = normalizePosition(value.range.end);
  if (!start || !end) {
    return null;
  }

  const severity = readNumber(value.severity);
  const code = typeof value.code === 'string' || typeof value.code === 'number'
    ? value.code
    : undefined;

  return {
    range: { start, end },
    severity,
    message: value.message,
    source: typeof value.source === 'string' ? value.source : undefined,
    code,
  };
}

function normalizeDiagnosticsParams(value: unknown): DiagnosticsParams | null {
  if (!isRecord(value) || typeof value.uri !== 'string' || !Array.isArray(value.diagnostics)) {
    return null;
  }

  return {
    uri: value.uri,
    diagnostics: value.diagnostics
      .map(normalizeDiagnostic)
      .filter((diagnostic): diagnostic is LSPDiagnostic => diagnostic !== null),
  };
}

function normalizeLSPMessage(value: unknown): LSPIncomingMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.id === 'number' && 'result' in value) {
    return {
      kind: 'result',
      id: value.id,
      result: value.result,
    };
  }

  if (typeof value.id === 'number' && isRecord(value.error)) {
    const message = typeof value.error.message === 'string'
      ? value.error.message
      : 'LSP request failed';
    return {
      kind: 'error',
      id: value.id,
      message,
    };
  }

  if (typeof value.method === 'string' && !('id' in value)) {
    return {
      kind: 'notification',
      method: value.method,
      params: value.params,
    };
  }

  return null;
}

// ============================================================================
// LSP Server
// ============================================================================

export class LSPServer extends EventEmitter {
  private config: LSPServerConfig;
  private process: ChildProcess | null = null;
  private state: LSPServerState = 'stopped';
  private nextRequestId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private messageBuffer = '';
  private workspaceRoot = '';
  private workspaceFolders: string[] = [];
  private restartCount = 0;

  private openDocuments = new Map<
    string,
    {
      uri: string;
      languageId: string;
      version: number;
      content: string;
    }
  >();

  constructor(config: LSPServerConfig) {
    super();
    this.config = config;
  }

  async start(workspaceRoot: string, workspaceFolders: string[] = [workspaceRoot]): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`Server already started (state: ${this.state})`);
    }

    this.workspaceRoot = workspaceRoot;
    this.workspaceFolders = Array.from(new Set(workspaceFolders));
    this.state = 'initializing';

    try {
      const resolved = await ensureInstalled({
        name: this.config.name,
        command: this.config.command,
        args: this.config.args ?? [],
        install: this.config.install,
      });

      this.process = spawn(resolved.command, resolved.args, {
        cwd: workspaceRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        console.error(`[LSP ${this.config.name}] ${data.toString()}`);
      });

      this.process.on('exit', (code) => {
        const wasReady = this.state === 'ready';
        this.state = 'stopped';
        this.emit('exit', code);

        if (wasReady && code !== 0 && this.config.restartOnCrash) {
          this.handleCrash();
        }
      });

      this.process.on('error', (err) => {
        this.state = 'error';
        this.emit('error', err);
      });

      // Send initialize request
      await this.sendRequest('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceRoot).href,
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didSave: true, didClose: true },
            completion: { completionItem: { snippetSupport: true } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            implementation: {},
            typeDefinition: {},
            callHierarchy: {},
          },
          workspace: { symbol: {}, workspaceFolders: true },
        },
        workspaceFolders: this.workspaceFolders.map((folder) => ({
          uri: pathToFileURL(folder).href,
          name: path.basename(folder),
        })),
      });

      this.sendNotification('initialized', {});
      this.state = 'ready';
      this.emit('ready');
      console.log(`[LSP] ${this.config.name} started successfully`);
    } catch (err) {
      this.state = 'error';
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;

    try {
      await this.sendRequest('shutdown', null);
      this.sendNotification('exit', null);
    } catch {
      // Ignore errors
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.state = 'stopped';
  }

  private handleCrash(): void {
    const maxRestarts = this.config.maxRestarts ?? 3;

    if (this.restartCount >= maxRestarts) {
      console.error(`[LSP] ${this.config.name} crashed too many times, not restarting`);
      return;
    }

    this.restartCount++;
    console.log(`[LSP] ${this.config.name} crashed, restarting (${this.restartCount}/${maxRestarts})...`);

    setTimeout(async () => {
      try {
        await this.start(this.workspaceRoot, this.workspaceFolders);
      } catch (err) {
        console.error(`[LSP] ${this.config.name} restart failed:`, err);
      }
    }, 1000);
  }

  private handleData(data: Buffer): void {
    this.messageBuffer += data.toString();

    while (true) {
      const headerEnd = this.messageBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerText = this.messageBuffer.substring(0, headerEnd);
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);

      if (!contentLengthMatch) {
        this.messageBuffer = '';
        break;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.messageBuffer.length < bodyEnd) break;

      const bodyText = this.messageBuffer.substring(bodyStart, bodyEnd);
      this.messageBuffer = this.messageBuffer.substring(bodyEnd);

      try {
        const message = normalizeLSPMessage(parseJsonValue(bodyText));
        if (message) {
          this.handleMessage(message);
        }
      } catch (err) {
        console.error('[LSP] Failed to parse message:', err);
      }
    }
  }

  private handleMessage(message: LSPIncomingMessage): void {
    if (message.kind === 'result') {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        pending.resolve(message.result);
      }
    } else if (message.kind === 'error') {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        pending.reject(new Error(message.message));
      }
    } else {
      this.emit('notification', message.method, message.params);

      if (message.method === 'textDocument/publishDiagnostics') {
        const diagnostics = normalizeDiagnosticsParams(message.params);
        if (diagnostics) {
          this.emit('diagnostics', diagnostics);
        }
      }
    }
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.state !== 'ready' && this.state !== 'initializing') {
      return Promise.reject(new Error('Server not ready'));
    }

    const id = this.nextRequestId++;
    const message: LSPOutgoingMessage = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.sendMessage(message);

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  sendNotification(method: string, params: unknown): void {
    const message: LSPOutgoingMessage = { jsonrpc: '2.0', method, params };
    this.sendMessage(message);
  }

  private sendMessage(message: LSPOutgoingMessage): void {
    if (!this.process?.stdin) {
      throw new Error('Process not started');
    }

    const content = JSON.stringify(message);
    const headers = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process.stdin.write(headers + content);
  }

  async openDocument(filePath: string, content: string, languageId: string): Promise<void> {
    const uri = pathToFileURL(filePath).href;

    if (this.openDocuments.has(filePath)) {
      await this.closeDocument(filePath);
    }

    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });

    this.openDocuments.set(filePath, { uri, languageId, version: 1, content });
  }

  async closeDocument(filePath: string): Promise<void> {
    const doc = this.openDocuments.get(filePath);
    if (!doc) return;

    this.sendNotification('textDocument/didClose', {
      textDocument: { uri: doc.uri },
    });

    this.openDocuments.delete(filePath);
  }

  /**
   * 通知文件内容变更（全量文档同步）
   */
  notifyDidChange(filePath: string, content: string): void {
    const doc = this.openDocuments.get(filePath);
    if (!doc) return;

    doc.version++;
    doc.content = content;

    this.sendNotification('textDocument/didChange', {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: content }],
    });
  }

  isDocumentOpen(filePath: string): boolean {
    return this.openDocuments.has(filePath);
  }

  getState(): LSPServerState {
    return this.state;
  }

  getConfig(): LSPServerConfig {
    return this.config;
  }
}

// ============================================================================
// LSP Server Manager
// ============================================================================

export interface LSPInstallFailure {
  source: LSPInstallSource | undefined;
  message: string;
}

export class LSPServerManager extends EventEmitter {
  private servers = new Map<string, LSPServer>();
  private serverConfigs: LSPServerConfig[] = [];
  private workspaceRoot: string;
  private workspaceFolders: string[];
  private state: 'initializing' | 'ready' | 'failed' = 'initializing';
  private diagnosticsCache = new Map<string, LSPDiagnostic[]>();
  private installFailures = new Map<string, LSPInstallFailure>();

  constructor(workspaceRoot: string, workspaceFolders: string[] = [workspaceRoot]) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.workspaceFolders = Array.from(new Set(workspaceFolders));
  }

  registerServer(config: LSPServerConfig): void {
    this.serverConfigs.push(config);
  }

  async initialize(): Promise<void> {
    console.log(`[LSP] Initializing ${this.serverConfigs.length} server(s)`);

    try {
      for (const config of this.serverConfigs) {
        const server = new LSPServer(config);

        server.on('diagnostics', (params: DiagnosticsParams) => {
          this.emit('diagnostics', params);
          this.diagnosticsCache.set(params.uri, params.diagnostics);
        });

        server.on('error', (err) => {
          console.error(`[LSP] ${config.name} error:`, err);
        });

        try {
          await server.start(this.workspaceRoot, this.workspaceFolders);
          this.servers.set(config.name, server);
        } catch (err) {
          if (err instanceof LSPInstallError) {
            console.warn(`[LSP] ${config.name} install failed: ${err.message}`);
            this.installFailures.set(config.name, {
              source: err.source,
              message: err.message,
            });
            this.emit('install-failed', {
              serverName: config.name,
              source: err.source,
              message: err.message,
            });
          } else {
            console.error(`[LSP] Failed to start ${config.name}:`, err);
          }
        }
      }

      this.state = 'ready';
      this.emit('ready');
      console.log(`[LSP] Initialized ${this.servers.size}/${this.serverConfigs.length} server(s)`);
    } catch (err) {
      this.state = 'failed';
      this.emit('error', err);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    for (const server of this.servers.values()) {
      try {
        await server.stop();
      } catch (err) {
        console.error('[LSP] Failed to stop server:', err);
      }
    }
    this.servers.clear();
  }

  getServerForFile(filePath: string): LSPServer | undefined {
    const ext = path.extname(filePath).toLowerCase();

    for (const [, server] of this.servers) {
      const config = server.getConfig();
      const normalizedExtensions = config.fileExtensions.map((e) =>
        e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`
      );

      if (normalizedExtensions.includes(ext)) {
        if (server.getState() === 'ready') {
          return server;
        }
      }
    }

    return undefined;
  }

  /**
   * If no live server matches the file but a configured server failed to
   * install, return that failure so callers can surface a useful hint
   * (e.g. include the install command in the tool error).
   */
  getInstallFailureForFile(filePath: string): LSPInstallFailure | undefined {
    const ext = path.extname(filePath).toLowerCase();

    for (const config of this.serverConfigs) {
      const normalizedExtensions = config.fileExtensions.map((e) =>
        e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`
      );

      if (normalizedExtensions.includes(ext)) {
        const failure = this.installFailures.get(config.name);
        if (failure) return failure;
      }
    }

    return undefined;
  }

  getAllServers(): Map<string, LSPServer> {
    return this.servers;
  }

  async openFile(filePath: string, content: string): Promise<void> {
    const server = this.getServerForFile(filePath);
    if (!server) return;

    const ext = path.extname(filePath).toLowerCase();
    const languageId = this.getLanguageId(ext);

    await server.openDocument(filePath, content, languageId);
  }

  isFileOpen(filePath: string): boolean {
    const server = this.getServerForFile(filePath);
    return server?.isDocumentOpen(filePath) ?? false;
  }

  async sendRequest(filePath: string, method: string, params: unknown): Promise<unknown> {
    const server = this.getServerForFile(filePath);
    if (!server) return undefined;

    return server.sendRequest(method, params);
  }

  private getLanguageId(ext: string): string {
    return getLanguageId(ext);
  }

  getStatus(): { status: 'initializing' | 'ready' | 'failed' } {
    return { status: this.state };
  }

  getDiagnostics(): Map<string, LSPDiagnostic[]> {
    return new Map(this.diagnosticsCache);
  }

  getFileDiagnostics(filePath: string): LSPDiagnostic[] {
    const uri = pathToFileURL(filePath).href;
    return this.diagnosticsCache.get(uri) || [];
  }

  /**
   * 通知文件变更：确保文件已打开 + 发送 didChange
   */
  async notifyFileChanged(filePath: string, content: string): Promise<void> {
    const server = this.getServerForFile(filePath);
    if (!server) return;

    if (!server.isDocumentOpen(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const languageId = this.getLanguageId(ext);
      await server.openDocument(filePath, content, languageId);
    } else {
      server.notifyDidChange(filePath, content);
    }
  }

  /**
   * 等待诊断结果（监听 diagnostics 事件，超时返回缓存值）
   */
  waitForDiagnostics(filePath: string, timeoutMs = 300): Promise<LSPDiagnostic[]> {
    const uri = pathToFileURL(filePath).href;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('diagnostics', handler);
        resolve(this.diagnosticsCache.get(uri) || []);
      }, timeoutMs);

      const handler = (params: { uri: string; diagnostics: LSPDiagnostic[] }) => {
        if (params.uri === uri) {
          clearTimeout(timer);
          this.removeListener('diagnostics', handler);
          resolve(params.diagnostics);
        }
      };

      this.on('diagnostics', handler);
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function isCommandAvailable(command: string): boolean {
  try {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checkCmd, [command], {
      stdio: 'pipe',
      shell: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Default Configurations
// ============================================================================

export const defaultLSPConfigs: LSPServerConfig[] = [
  {
    name: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    extensionToLanguage: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
    },
    restartOnCrash: true,
    maxRestarts: 3,
    install: {
      type: 'npm',
      packages: ['typescript-language-server', 'typescript'],
      binName: 'typescript-language-server',
    },
  },
  {
    name: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileExtensions: ['.py'],
    extensionToLanguage: { '.py': 'python' },
    restartOnCrash: true,
    maxRestarts: 3,
    install: {
      type: 'npm',
      packages: ['pyright'],
      binName: 'pyright-langserver',
    },
  },
  {
    name: 'gopls',
    command: 'gopls',
    args: ['serve'],
    fileExtensions: ['.go'],
    extensionToLanguage: { '.go': 'go' },
    restartOnCrash: true,
    maxRestarts: 3,
    install: {
      type: 'system',
      installCmd: 'go install golang.org/x/tools/gopls@latest',
      docUrl: 'https://github.com/golang/tools/tree/master/gopls',
    },
  },
  {
    name: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    fileExtensions: ['.rs'],
    extensionToLanguage: { '.rs': 'rust' },
    restartOnCrash: true,
    maxRestarts: 3,
    install: {
      type: 'system',
      installCmd: 'rustup component add rust-analyzer',
      docUrl: 'https://rust-analyzer.github.io/manual.html#installation',
    },
  },
];

// ============================================================================
// Global Instance
// ============================================================================

let globalManager: LSPServerManager | null = null;

export async function initializeLSPManager(
  workspaceRoot: string,
  workspaceFolders: string[] = [workspaceRoot],
): Promise<LSPServerManager> {
  if (globalManager) {
    await globalManager.shutdown();
  }

  globalManager = new LSPServerManager(workspaceRoot, workspaceFolders);

  for (const config of defaultLSPConfigs) {
    globalManager.registerServer(config);
  }

  await globalManager.initialize();

  return globalManager;
}

export function getLSPManager(): LSPServerManager | null {
  return globalManager;
}

export function checkLSPServerInstalled(serverName: string): boolean {
  const config = defaultLSPConfigs.find((c) => c.name === serverName);
  if (config) {
    return isCommandAvailable(config.command);
  }
  return false;
}
