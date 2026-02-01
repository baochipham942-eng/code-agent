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
import * as fs from 'fs';

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
      resolve: (result: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private messageBuffer = '';
  private workspaceRoot = '';
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

  async start(workspaceRoot: string): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`Server already started (state: ${this.state})`);
    }

    this.workspaceRoot = workspaceRoot;
    this.state = 'initializing';

    try {
      this.process = spawn(this.config.command, this.config.args || [], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      this.process.stdout!.on('data', (data) => {
        this.handleData(data);
      });

      this.process.stderr!.on('data', (data) => {
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
        workspaceFolders: [
          {
            uri: pathToFileURL(workspaceRoot).href,
            name: path.basename(workspaceRoot),
          },
        ],
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
        await this.start(this.workspaceRoot);
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
        const message = JSON.parse(bodyText);
        this.handleMessage(message);
      } catch (err) {
        console.error('[LSP] Failed to parse message:', err);
      }
    }
  }

  private handleMessage(message: any): void {
    if ('id' in message && 'result' in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        pending.resolve(message.result);
      }
    } else if ('id' in message && 'error' in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        pending.reject(new Error(message.error.message));
      }
    } else if ('method' in message && !('id' in message)) {
      this.emit('notification', message.method, message.params);

      if (message.method === 'textDocument/publishDiagnostics') {
        this.emit('diagnostics', message.params);
      }
    }
  }

  sendRequest(method: string, params: any): Promise<any> {
    if (this.state !== 'ready' && this.state !== 'initializing') {
      return Promise.reject(new Error('Server not ready'));
    }

    const id = this.nextRequestId++;
    const message = { jsonrpc: '2.0', id, method, params };

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

  sendNotification(method: string, params: any): void {
    const message = { jsonrpc: '2.0', method, params };
    this.sendMessage(message);
  }

  private sendMessage(message: any): void {
    if (!this.process || !this.process.stdin) {
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

export class LSPServerManager extends EventEmitter {
  private servers = new Map<string, LSPServer>();
  private serverConfigs: LSPServerConfig[] = [];
  private workspaceRoot: string;
  private state: 'initializing' | 'ready' | 'failed' = 'initializing';
  private diagnosticsCache = new Map<string, LSPDiagnostic[]>();

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  registerServer(config: LSPServerConfig): void {
    this.serverConfigs.push(config);
  }

  async initialize(): Promise<void> {
    console.log(`[LSP] Initializing ${this.serverConfigs.length} server(s)`);

    try {
      for (const config of this.serverConfigs) {
        if (!isCommandAvailable(config.command)) {
          console.warn(`[LSP] Skipping ${config.name}: command not available`);
          continue;
        }

        const server = new LSPServer(config);

        server.on('diagnostics', (params) => {
          this.emit('diagnostics', params);
          this.diagnosticsCache.set(params.uri, params.diagnostics);
        });

        server.on('error', (err) => {
          console.error(`[LSP] ${config.name} error:`, err);
        });

        try {
          await server.start(this.workspaceRoot);
          this.servers.set(config.name, server);
        } catch (err) {
          console.error(`[LSP] Failed to start ${config.name}:`, err);
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

  async sendRequest(filePath: string, method: string, params: any): Promise<any> {
    const server = this.getServerForFile(filePath);
    if (!server) return undefined;

    return server.sendRequest(method, params);
  }

  private getLanguageId(ext: string): string {
    const mapping: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c',
      '.cs': 'csharp',
      '.rb': 'ruby',
      '.php': 'php',
    };

    return mapping[ext] || 'plaintext';
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
  },
  {
    name: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileExtensions: ['.py'],
    extensionToLanguage: { '.py': 'python' },
    restartOnCrash: true,
    maxRestarts: 3,
  },
  {
    name: 'gopls',
    command: 'gopls',
    args: ['serve'],
    fileExtensions: ['.go'],
    extensionToLanguage: { '.go': 'go' },
    restartOnCrash: true,
    maxRestarts: 3,
  },
  {
    name: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    fileExtensions: ['.rs'],
    extensionToLanguage: { '.rs': 'rust' },
    restartOnCrash: true,
    maxRestarts: 3,
  },
];

// ============================================================================
// Global Instance
// ============================================================================

let globalManager: LSPServerManager | null = null;

export async function initializeLSPManager(workspaceRoot: string): Promise<LSPServerManager> {
  if (globalManager) {
    await globalManager.shutdown();
  }

  globalManager = new LSPServerManager(workspaceRoot);

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
