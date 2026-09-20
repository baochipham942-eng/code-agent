// ============================================================================
// Agent Engine History Import Preview
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import type { Dirent, Stats } from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import type { AgentEngineKind } from '../../../shared/contract/agentEngine';
import { CODEX_SESSION } from '../../../shared/constants';
import {
  parseClaudeSession,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ParsedClaudeSession,
} from '../../session/claudeSessionParser';
import {
  parseCodexSession,
} from '../../session/codexSessionParser';

export type AgentEngineHistoryEngineKind = Extract<AgentEngineKind, 'codex_cli' | 'claude_code'>;

export interface AgentEngineHistoryDiagnostic {
  level: 'warning' | 'error';
  code: string;
  message: string;
  sourcePath?: string;
}

export interface AgentEngineHistorySummary {
  engineKind: AgentEngineHistoryEngineKind;
  externalSessionId: string;
  sourcePath: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  cwd?: string;
  workingDirectory?: string;
  canImport: boolean;
  diagnostics: AgentEngineHistoryDiagnostic[];
}

export interface AgentEngineHistoryListRequest {
  engine: AgentEngineHistoryEngineKind;
  limit?: number;
}

export interface AgentEngineHistoryListResult {
  engine: AgentEngineHistoryEngineKind;
  limit: number;
  items: AgentEngineHistorySummary[];
  diagnostics: AgentEngineHistoryDiagnostic[];
}

export interface AgentEngineNormalizedPreviewMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp?: number;
}

export interface AgentEngineHistoryPreviewRequest {
  engine: AgentEngineHistoryEngineKind;
  externalSessionId?: string;
  sourcePath?: string;
  previewLimit?: number;
}

export interface AgentEngineHistoryPreviewResult {
  summary: AgentEngineHistorySummary;
  preview: {
    messages: AgentEngineNormalizedPreviewMessage[];
    diagnostics: AgentEngineHistoryDiagnostic[];
  };
}

export class AgentEngineHistoryImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentEngineHistoryImportError';
  }
}

interface AgentEngineHistoryImportRoots {
  codexSessionsRoot?: string;
  claudeProjectsRoot?: string;
}

interface AgentEngineHistoryImportParsers {
  parseCodexSession?: typeof parseCodexSession;
  parseClaudeSession?: typeof parseClaudeSession;
}

export interface AgentEngineHistoryImportServiceOptions {
  roots?: AgentEngineHistoryImportRoots;
  parsers?: AgentEngineHistoryImportParsers;
}

interface HistorySourceFile {
  sourcePath: string;
  updatedAt: number;
}

interface CodexPreviewScan {
  messages: AgentEngineNormalizedPreviewMessage[];
  messageCount: number;
  firstUserText?: string;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_PREVIEW_LIMIT = 12;
const MAX_PREVIEW_LIMIT = 50;
const CODEX_PREVIEW_MAX_LINE_LENGTH = CODEX_SESSION.MAX_LINE_LENGTH;

export class AgentEngineHistoryImportService {
  private readonly roots: Required<AgentEngineHistoryImportRoots>;
  private readonly parsers: Required<AgentEngineHistoryImportParsers>;

  constructor(options: AgentEngineHistoryImportServiceOptions = {}) {
    this.roots = {
      codexSessionsRoot: path.resolve(options.roots?.codexSessionsRoot ?? expandHome(CODEX_SESSION.DIR)),
      claudeProjectsRoot: path.resolve(options.roots?.claudeProjectsRoot ?? path.join(os.homedir(), '.claude', 'projects')),
    };
    this.parsers = {
      parseCodexSession: options.parsers?.parseCodexSession ?? parseCodexSession,
      parseClaudeSession: options.parsers?.parseClaudeSession ?? parseClaudeSession,
    };
  }

  async listHistory(request: AgentEngineHistoryListRequest): Promise<AgentEngineHistoryListResult> {
    const payload = asRecord(request);
    const engine = normalizeHistoryEngineKind(payload.engine);
    const limit = normalizeHistoryLimit(payload.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const scan = await this.findHistoryFiles(engine);

    const items: AgentEngineHistorySummary[] = [];
    for (const source of scan.files.slice(0, limit)) {
      items.push(await this.summarizeSource(engine, source));
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt);

    return {
      engine,
      limit,
      items: items.slice(0, limit),
      diagnostics: scan.diagnostics,
    };
  }

  async previewHistory(request: AgentEngineHistoryPreviewRequest): Promise<AgentEngineHistoryPreviewResult> {
    const payload = asRecord(request);
    const engine = normalizeHistoryEngineKind(payload.engine);
    const previewLimit = normalizeHistoryLimit(payload.previewLimit, DEFAULT_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);
    const source = await this.resolvePreviewSource(engine, payload);
    const summary = await this.summarizeSource(engine, source);

    try {
      const messages = engine === 'codex_cli'
        ? (await this.scanCodexPreview(source.sourcePath, previewLimit)).messages
        : await this.buildClaudePreview(source.sourcePath, previewLimit);

      return {
        summary,
        preview: {
          messages,
          diagnostics: [],
        },
      };
    } catch (error) {
      const diagnostic = createDiagnostic('error', 'PREVIEW_PARSE_FAILED', error, source.sourcePath);
      return {
        summary: {
          ...summary,
          canImport: false,
          diagnostics: [...summary.diagnostics, diagnostic],
        },
        preview: {
          messages: [],
          diagnostics: [diagnostic],
        },
      };
    }
  }

  private async summarizeSource(
    engine: AgentEngineHistoryEngineKind,
    source: HistorySourceFile,
  ): Promise<AgentEngineHistorySummary> {
    try {
      return engine === 'codex_cli'
        ? await this.summarizeCodexSource(source)
        : await this.summarizeClaudeSource(source);
    } catch (error) {
      const diagnostic = createDiagnostic('error', 'SESSION_PARSE_FAILED', error, source.sourcePath);
      return this.createFallbackSummary(engine, source, [diagnostic]);
    }
  }

  private async summarizeCodexSource(source: HistorySourceFile): Promise<AgentEngineHistorySummary> {
    const parsed = await this.parsers.parseCodexSession(source.sourcePath);
    const scan = await this.scanCodexPreview(source.sourcePath, 1);
    const cwd = parsed.metadata.cwd || undefined;
    const messageCount = scan.messageCount || parsed.assistantMessages.length;
    const diagnostics = messageCount > 0
      ? []
      : [createDiagnostic('warning', 'NO_IMPORTABLE_MESSAGES', 'No importable Codex messages were found.', source.sourcePath)];

    return {
      engineKind: 'codex_cli',
      externalSessionId: parsed.metadata.sessionId || deriveCodexExternalSessionId(source.sourcePath),
      sourcePath: source.sourcePath,
      title: makeTitle(scan.firstUserText, parsed.assistantMessages[0], parsed.metadata.sessionId),
      messageCount,
      updatedAt: source.updatedAt,
      ...(cwd ? { cwd, workingDirectory: cwd } : {}),
      canImport: diagnostics.length === 0,
      diagnostics,
    };
  }

  private async summarizeClaudeSource(source: HistorySourceFile): Promise<AgentEngineHistorySummary> {
    const parsed = await this.parsers.parseClaudeSession(source.sourcePath, { skipProgress: true });
    const cwd = parsed.metadata.cwd || undefined;
    const workingDirectory = cwd || parsed.metadata.projectPath || undefined;
    const updatedAt = parsed.metadata.endedAt ?? parsed.metadata.startedAt ?? source.updatedAt;
    const messageCount = parsed.metadata.messageCount;
    const diagnostics = parsed.parseErrors > 0
      ? [createTextDiagnostic(
        'warning',
        'SESSION_PARSE_ERRORS',
        `${parsed.parseErrors} Claude Code JSONL line(s) could not be parsed.`,
        source.sourcePath,
      )]
      : [];

    if (messageCount === 0) {
      diagnostics.push(createTextDiagnostic(
        'warning',
        'NO_IMPORTABLE_MESSAGES',
        'No importable Claude Code messages were found.',
        source.sourcePath,
      ));
    }

    return {
      engineKind: 'claude_code',
      externalSessionId: parsed.metadata.sessionId || path.basename(source.sourcePath, '.jsonl'),
      sourcePath: source.sourcePath,
      title: makeTitle(parsed.metadata.firstPrompt, firstClaudeMessageText(parsed), parsed.metadata.sessionId),
      messageCount,
      updatedAt,
      ...(cwd ? { cwd } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      canImport: messageCount > 0,
      diagnostics,
    };
  }

  private async buildClaudePreview(
    sourcePath: string,
    previewLimit: number,
  ): Promise<AgentEngineNormalizedPreviewMessage[]> {
    const parsed = await this.parsers.parseClaudeSession(sourcePath, { skipProgress: true });
    return dedupeAdjacentMessages(parsed.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        text: textFromClaudeContent(message.content),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      }))
      .filter((message) => message.text.length > 0)
      .slice(0, previewLimit));
  }

  private async scanCodexPreview(
    sourcePath: string,
    previewLimit: number,
  ): Promise<CodexPreviewScan> {
    const messages: AgentEngineNormalizedPreviewMessage[] = [];
    let messageCount = 0;
    let firstUserText: string | undefined;

    const stream = fsSync.createReadStream(sourcePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        if (line.length > CODEX_PREVIEW_MAX_LINE_LENGTH) continue;

        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const extracted = extractCodexNormalizedMessage(obj);
        if (!extracted) continue;

        messageCount++;
        if (!firstUserText && extracted.role === 'user') {
          firstUserText = extracted.text;
        }
        if (messages.length < previewLimit) {
          messages.push(extracted);
        }
      }
    } finally {
      stream.destroy();
    }

    return {
      messages: dedupeAdjacentMessages(messages),
      messageCount,
      firstUserText,
    };
  }

  private async resolvePreviewSource(
    engine: AgentEngineHistoryEngineKind,
    request: Record<string, unknown>,
  ): Promise<HistorySourceFile> {
    const requestedSourcePath = typeof request.sourcePath === 'string' ? request.sourcePath : undefined;
    if (requestedSourcePath) {
      const sourcePath = await this.assertAllowedSourcePath(engine, requestedSourcePath);
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        throw new AgentEngineHistoryImportError('INVALID_SOURCE', 'History source must be a JSONL file.', { sourcePath });
      }
      return { sourcePath, updatedAt: stat.mtimeMs };
    }

    const externalSessionId = typeof request.externalSessionId === 'string'
      ? request.externalSessionId.trim()
      : '';
    if (!externalSessionId) {
      throw new AgentEngineHistoryImportError(
        'INVALID_PAYLOAD',
        'previewHistory requires either externalSessionId or sourcePath.',
      );
    }

    const scan = await this.findHistoryFiles(engine);
    let source = scan.files.find((file) => this.matchesExternalSessionId(engine, file.sourcePath, externalSessionId));
    if (!source) {
      for (const candidate of scan.files) {
        const summary = await this.summarizeSource(engine, candidate);
        if (summary.externalSessionId === externalSessionId) {
          source = candidate;
          break;
        }
      }
    }

    if (!source) {
      throw new AgentEngineHistoryImportError(
        'HISTORY_NOT_FOUND',
        `No ${engine} history session matched ${externalSessionId}.`,
        { externalSessionId },
      );
    }
    return source;
  }

  private matchesExternalSessionId(
    engine: AgentEngineHistoryEngineKind,
    sourcePath: string,
    externalSessionId: string,
  ): boolean {
    if (engine === 'claude_code') {
      return path.basename(sourcePath, '.jsonl') === externalSessionId;
    }
    return deriveCodexExternalSessionId(sourcePath) === externalSessionId
      || path.basename(sourcePath, '.jsonl').includes(externalSessionId);
  }

  private async assertAllowedSourcePath(
    engine: AgentEngineHistoryEngineKind,
    candidate: string,
  ): Promise<string> {
    const sourcePath = path.resolve(candidate);
    const root = this.rootForEngine(engine);
    const [realRoot, realSource] = await Promise.all([
      fs.realpath(root).catch(() => path.resolve(root)),
      fs.realpath(sourcePath),
    ]);

    if (!isPathInside(realSource, realRoot)) {
      throw new AgentEngineHistoryImportError(
        'SOURCE_OUTSIDE_HISTORY_ROOT',
        `${engine} history preview can only read files under ${root}.`,
        { sourcePath, root },
      );
    }

    if (!sourcePath.endsWith('.jsonl')) {
      throw new AgentEngineHistoryImportError('INVALID_SOURCE', 'History source must be a .jsonl file.', { sourcePath });
    }

    if (engine === 'codex_cli' && !path.basename(sourcePath).startsWith('rollout-')) {
      throw new AgentEngineHistoryImportError(
        'INVALID_SOURCE',
        'Codex history source must be a rollout JSONL file.',
        { sourcePath },
      );
    }

    return sourcePath;
  }

  private rootForEngine(engine: AgentEngineHistoryEngineKind): string {
    return engine === 'codex_cli'
      ? this.roots.codexSessionsRoot
      : this.roots.claudeProjectsRoot;
  }

  private async findHistoryFiles(engine: AgentEngineHistoryEngineKind): Promise<{
    files: HistorySourceFile[];
    diagnostics: AgentEngineHistoryDiagnostic[];
  }> {
    return engine === 'codex_cli'
      ? await this.findCodexHistoryFiles()
      : await this.findClaudeHistoryFiles();
  }

  private async findCodexHistoryFiles(): Promise<{
    files: HistorySourceFile[];
    diagnostics: AgentEngineHistoryDiagnostic[];
  }> {
    const root = this.roots.codexSessionsRoot;
    const diagnostics: AgentEngineHistoryDiagnostic[] = [];
    const files: HistorySourceFile[] = [];
    const years = await safeReadDir(root, diagnostics);

    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const yearPath = path.join(root, year.name);
      const months = await safeReadDir(yearPath, diagnostics);

      for (const month of months) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        const monthPath = path.join(yearPath, month.name);
        const days = await safeReadDir(monthPath, diagnostics);

        for (const day of days) {
          if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
          const dayPath = path.join(monthPath, day.name);
          const entries = await safeReadDir(dayPath, diagnostics);

          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
            const sourcePath = path.join(dayPath, entry.name);
            const stat = await safeStat(sourcePath, diagnostics);
            if (stat) files.push({ sourcePath, updatedAt: stat.mtimeMs });
          }
        }
      }
    }

    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return { files, diagnostics };
  }

  private async findClaudeHistoryFiles(): Promise<{
    files: HistorySourceFile[];
    diagnostics: AgentEngineHistoryDiagnostic[];
  }> {
    const root = this.roots.claudeProjectsRoot;
    const diagnostics: AgentEngineHistoryDiagnostic[] = [];
    const files: HistorySourceFile[] = [];
    const projects = await safeReadDir(root, diagnostics);

    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectPath = path.join(root, project.name);
      const entries = await safeReadDir(projectPath, diagnostics);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const sourcePath = path.join(projectPath, entry.name);
        const stat = await safeStat(sourcePath, diagnostics);
        if (stat) files.push({ sourcePath, updatedAt: stat.mtimeMs });
      }
    }

    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return { files, diagnostics };
  }

  private createFallbackSummary(
    engine: AgentEngineHistoryEngineKind,
    source: HistorySourceFile,
    diagnostics: AgentEngineHistoryDiagnostic[],
  ): AgentEngineHistorySummary {
    const externalSessionId = engine === 'codex_cli'
      ? deriveCodexExternalSessionId(source.sourcePath)
      : path.basename(source.sourcePath, '.jsonl');

    return {
      engineKind: engine,
      externalSessionId,
      sourcePath: source.sourcePath,
      title: externalSessionId,
      messageCount: 0,
      updatedAt: source.updatedAt,
      canImport: false,
      diagnostics,
    };
  }
}

let instance: AgentEngineHistoryImportService | null = null;

export function getAgentEngineHistoryImportService(): AgentEngineHistoryImportService {
  if (!instance) {
    instance = new AgentEngineHistoryImportService();
  }
  return instance;
}

function normalizeHistoryEngineKind(engine: unknown): AgentEngineHistoryEngineKind {
  if (engine === 'codex_cli' || engine === 'claude_code') {
    return engine;
  }
  throw new AgentEngineHistoryImportError(
    'INVALID_ENGINE',
    'History import only supports codex_cli and claude_code.',
    { engine },
  );
}

function normalizeHistoryLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function safeReadDir(
  dirPath: string,
  diagnostics: AgentEngineHistoryDiagnostic[],
): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    const code = isMissingPathError(error) ? 'HISTORY_ROOT_NOT_FOUND' : 'HISTORY_DIR_READ_FAILED';
    diagnostics.push(createDiagnostic('warning', code, error, dirPath));
    return [];
  }
}

async function safeStat(
  sourcePath: string,
  diagnostics: AgentEngineHistoryDiagnostic[],
): Promise<Stats | null> {
  try {
    return await fs.stat(sourcePath);
  } catch (error) {
    diagnostics.push(createDiagnostic('warning', 'HISTORY_FILE_STAT_FAILED', error, sourcePath));
    return null;
  }
}

function createDiagnostic(
  level: 'warning' | 'error',
  code: string,
  error: unknown,
  sourcePath?: string,
): AgentEngineHistoryDiagnostic {
  return createTextDiagnostic(level, code, error instanceof Error ? error.message : String(error), sourcePath);
}

function createTextDiagnostic(
  level: 'warning' | 'error',
  code: string,
  message: string,
  sourcePath?: string,
): AgentEngineHistoryDiagnostic {
  return {
    level,
    code,
    message,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isPathInside(sourcePath: string, root: string): boolean {
  const relative = path.relative(root, sourcePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function deriveCodexExternalSessionId(sourcePath: string): string {
  const base = path.basename(sourcePath, '.jsonl');
  const parts = base.split('-');
  return parts.length >= 7 ? parts.slice(6).join('-') : base;
}

function makeTitle(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const title = candidate.replace(/\s+/g, ' ').trim();
    if (title) return title.slice(0, 120);
  }
  return 'Untitled history session';
}

function firstClaudeMessageText(parsed: ParsedClaudeSession): string | undefined {
  const first = parsed.messages.find((message) => message.role === 'user' || message.role === 'assistant');
  return first ? textFromClaudeContent(first.content) : undefined;
}

function textFromClaudeContent(content: ClaudeMessage['content']): string {
  if (typeof content === 'string') {
    return content.replace(/\s+/g, ' ').trim();
  }
  return content
    .map((block) => textFromClaudeBlock(block))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textFromClaudeBlock(block: ClaudeContentBlock): string {
  if (typeof block.text === 'string') return block.text;
  if (typeof block.thinking === 'string') return block.thinking;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((item) => item.text ?? '')
      .filter(Boolean)
      .join(' ');
  }
  if (block.name) return `[tool] ${block.name}`;
  return '';
}

function extractCodexNormalizedMessage(obj: Record<string, unknown>): AgentEngineNormalizedPreviewMessage | null {
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return null;

  const timestamp = parseAnyTimestamp(payload.timestamp ?? obj.timestamp);
  if (obj.type === 'event_msg') {
    const subtype = payload.type as string | undefined;
    if (subtype === 'user_message') {
      return makePreviewMessage('user', payload.message, timestamp);
    }
    if (subtype === 'agent_message') {
      return makePreviewMessage('assistant', payload.message, timestamp);
    }
    if (subtype === 'task_complete') {
      return makePreviewMessage('assistant', payload.last_agent_message, timestamp);
    }
  }

  if (obj.type === 'response_item' && payload.type === 'message') {
    const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : 'system';
    return makePreviewMessage(role, textFromCodexContent(payload.content), timestamp);
  }

  return null;
}

function makePreviewMessage(
  role: AgentEngineNormalizedPreviewMessage['role'],
  textValue: unknown,
  timestamp?: number,
): AgentEngineNormalizedPreviewMessage | null {
  const text = typeof textValue === 'string'
    ? textValue.replace(/\s+/g, ' ').trim()
    : '';
  if (!text) return null;
  return {
    role,
    text,
    ...(timestamp ? { timestamp } : {}),
  };
}

function textFromCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const item = block as Record<string, unknown>;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function parseAnyTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function dedupeAdjacentMessages<T extends AgentEngineNormalizedPreviewMessage>(messages: T[]): T[] {
  const deduped: T[] = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.role === message.role && previous.text === message.text) {
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}
