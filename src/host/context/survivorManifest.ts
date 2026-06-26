import { createHash } from 'crypto';
import path from 'path';
import type { CompactionSurvivorManifest, Message } from '../../shared/contract';
import type { ToolCall, ToolResult } from '../../shared/contract/tool';
import type { ToolResultArchiveRef } from '../utils/toolResultSpill';
import type { CompressedMessage } from './tokenOptimizer';
import { estimateTokens } from './tokenEstimator';

export type SurvivorManifestSource =
  | 'manual_current'
  | 'manual_from_message'
  | 'auto_threshold'
  | 'overflow_recovery'
  | string;

export interface SurvivorManifestBuildOptions {
  sessionId?: string;
  source?: SurvivorManifestSource;
  anchorMessageId?: string;
  preserveRecentCount?: number;
  compactedMessageIds?: string[];
  preservedMessageIds?: string[];
  maxTokens?: number;
  maxChars?: number;
  maxItemChars?: number;
  maxFileExcerptChars?: number;
  maxFileExcerptTotalChars?: number;
  fileReadRecords?: Array<{ path: string; mtime?: number; readTime?: number; size?: number }>;
  dataFingerprintText?: string;
  archivedToolResults?: ToolResultArchiveRef[];
}

export interface BuildSurvivorManifestInput extends SurvivorManifestBuildOptions {
  messages: SurvivorManifestMessage[];
}

export interface CompactMessagesForSummaryOptions {
  maxContentChars?: number;
  maxItemChars?: number;
  maxTotalTokens?: number;
}

export interface SurvivorTextItem {
  messageId?: string;
  text: string;
}

export interface SurvivorShellCommandSummary {
  messageId?: string;
  command: string;
  cwd?: string;
  exitCode?: number | string;
  success?: boolean;
  stdoutSummary?: string;
  stderrSummary?: string;
  errorSummary?: string;
}

export interface SurvivorArtifactSummary {
  messageId?: string;
  path: string;
  source: 'tool_result' | 'metadata' | 'artifact' | 'message';
}

export interface SurvivorArchivedToolResultSummary {
  artifactId: string;
  filePath: string;
  toolName: string;
  sessionId: string;
  sha256: string;
  bytes: number;
  reason: string;
  toolCallId?: string;
  sourceMessageId?: string;
}

export type SurvivorFileSurvival = 'path_only' | 'digest' | 'excerpt';

export interface SurvivorFileMetadata {
  size?: number;
  mtime?: number;
  readTime?: number;
  textLike?: boolean;
  truncated?: boolean;
  sensitive?: boolean;
}

export interface SurvivorFileRecord {
  path: string;
  reason?: string;
  lastKnownReason?: string;
  needsReRead: boolean;
  survival: SurvivorFileSurvival;
  digest?: string;
  excerpt?: string;
  metadata?: SurvivorFileMetadata;
  messageIds?: string[];
}

export interface ContextSurvivorManifest
  extends Omit<
    CompactionSurvivorManifest,
    'source'
      | 'preserveRecentCount'
      | 'commands'
      | 'errors'
      | 'openWork'
      | 'artifacts'
      | 'archivedToolResults'
  > {
  sessionId?: string;
  source?: SurvivorManifestSource;
  anchorMessageId?: string;
  preserveRecentCount: number;
  compactedMessageIds: string[];
  preservedMessageIds: string[];
  filePaths: string[];
  files: SurvivorFileRecord[];
  commands: SurvivorShellCommandSummary[];
  errors: SurvivorTextItem[];
  todos: SurvivorTextItem[];
  openWork: SurvivorTextItem[];
  artifacts: SurvivorArtifactSummary[];
  archivedToolResults: SurvivorArchivedToolResultSummary[];
  dataFingerprintText: string;
  dataFingerprint?: string;
}

export type SurvivorManifestMessage = Partial<Message> & Partial<CompressedMessage>;

const DEFAULT_PRESERVE_RECENT_COUNT = 6;
const DEFAULT_MAX_ITEM_CHARS = 280;
const DEFAULT_MAX_FILE_EXCERPT_CHARS = 360;
const DEFAULT_MAX_FILE_EXCERPT_TOTAL_CHARS = 1400;
const LARGE_FILE_BYTES = 96 * 1024;
const APPROX_CHARS_PER_TOKEN = 4;

const ABSOLUTE_PATH_RE =
  /(?:^|[\s([{<"'`])((?:\/(?:[^/\s"'`<>|:*?()[\]{};,]+))+|[A-Za-z]:\\(?:[^\\\s"'`<>|:*?()[\]{};,]+\\?)+)/g;

const TODO_RE = /\b(?:TODO|FIXME|HACK|task|todo|open work|follow[- ]?up)\b|^\s*[-*]\s+\[[ xX]\]/i;
const ERROR_RE =
  /\b(?:error|assertionerror|exception|traceback|failed|failure|fatal|panic|enoent|eacces|timeout|timed out|stderr|exit code|exit status|segmentation fault)\b/i;
const READ_TOOL_RE = /^(?:read|read_file|file_read|Read)$/i;
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cfg',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.lua',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);
const BINARY_OR_RICH_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bin',
  '.bmp',
  '.doc',
  '.docx',
  '.dmg',
  '.gif',
  '.gz',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.sqlite',
  '.webp',
  '.xls',
  '.xlsx',
  '.zip',
]);
const SENSITIVE_PATH_RE =
  /(?:^|\/)(?:\.env(?:[./-].*)?|id_rsa|id_dsa|id_ed25519|credentials?|secrets?|tokens?|private[-_]?key|api[-_]?key)(?:$|[./-])/i;
const SENSITIVE_CONTENT_RE =
  /\b(?:api[_-]?key|secret|token|authorization|bearer|password|private[_-]?key|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY)\b/i;

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function clampText(value: string, maxChars: number): string {
  const text = normalizeWhitespace(value);
  if (text.length <= maxChars) return text;
  const marker = '... [truncated] ...';
  const head = Math.max(0, Math.floor(maxChars * 0.65));
  const tail = Math.max(0, maxChars - head - marker.length);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function itemBudget(options: SurvivorManifestBuildOptions): number {
  return Math.max(40, options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS);
}

function manifestBudget(options: SurvivorManifestBuildOptions): number | undefined {
  if (typeof options.maxChars === 'number') return Math.max(0, options.maxChars);
  if (typeof options.maxTokens === 'number') return Math.max(0, options.maxTokens * APPROX_CHARS_PER_TOKEN);
  return undefined;
}

function getMessageId(message: SurvivorManifestMessage, index: number): string {
  return message.id || `message-${index}`;
}

function getMessageContent(message: SurvivorManifestMessage): string {
  const parts = Array.isArray(message.contentParts)
    ? message.contentParts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
    : '';
  const content = asText(message.content);
  return [content, parts, asText(message.reasoning), asText(message.thinking)].filter(Boolean).join('\n');
}

function uniquePush(list: string[], seen: Set<string>, value: string | undefined): void {
  if (!value) return;
  if (seen.has(value)) return;
  seen.add(value);
  list.push(value);
}

function stripPathPunctuation(path: string): string {
  return path.replace(/[.,;:!?]+$/g, '').replace(/[\])}]+$/g, '');
}

function normalizePathLike(value: string | undefined, cwd?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = stripPathPunctuation(value.trim());
  if (!cleaned) return undefined;
  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, cleaned);
  return cleaned.startsWith('/') ? cleaned : undefined;
}

function isTextLikePath(filePath: string): boolean {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (BINARY_OR_RICH_EXTENSIONS.has(ext)) return false;
  return /^(?:AGENTS|CLAUDE|README|LICENSE|Makefile|Dockerfile)(?:\..*)?$/i.test(base);
}

function hasSensitiveRisk(filePath: string, text?: string): boolean {
  return SENSITIVE_PATH_RE.test(filePath) || (text ? SENSITIVE_CONTENT_RE.test(text) : false);
}

function removeReadLineNumbers(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function readToolPath(call: ToolCall): string | undefined {
  if (!READ_TOOL_RE.test(call.name)) return undefined;
  const args = call.arguments || {};
  return normalizePathLike(
    typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.path === 'string'
        ? args.path
        : undefined,
    toolCallCwd(call),
  );
}

export function extractAbsoluteFilePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const path = stripPathPunctuation(match[1] ?? '');
    if (!path || path === '/') continue;
    uniquePush(paths, seen, path);
  }
  return paths;
}

export const extractAbsolutePaths = extractAbsoluteFilePaths;

function collectPathValue(value: unknown, paths: string[], seen: Set<string>): void {
  if (typeof value === 'string') {
    for (const path of extractAbsoluteFilePaths(value)) {
      uniquePush(paths, seen, path);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPathValue(item, paths, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/path|file|output|artifact/i.test(key)) {
      collectPathValue(nested, paths, seen);
    }
  }
}

function getToolCalls(message: SurvivorManifestMessage): ToolCall[] {
  return Array.isArray(message.toolCalls) ? (message.toolCalls as ToolCall[]) : [];
}

function getToolResults(message: SurvivorManifestMessage): ToolResult[] {
  return Array.isArray(message.toolResults) ? (message.toolResults as ToolResult[]) : [];
}

function toolCallCommand(call: ToolCall): string | undefined {
  const args = call.arguments || {};
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  if (typeof args.script === 'string' && /bash|shell|exec|terminal/i.test(call.name)) return args.script;
  return undefined;
}

function toolCallCwd(call: ToolCall): string | undefined {
  const args = call.arguments || {};
  if (typeof args.cwd === 'string') return args.cwd;
  if (typeof args.workingDirectory === 'string') return args.workingDirectory;
  if (typeof args.workdir === 'string') return args.workdir;
  return undefined;
}

function resultExitCode(result: ToolResult): number | string | undefined {
  const meta = result.metadata || {};
  const direct = (result as unknown as { exitCode?: unknown; code?: unknown }).exitCode;
  const code = direct ?? meta.exitCode ?? meta.code;
  if (typeof code === 'number' || typeof code === 'string') return code;
  return undefined;
}

function splitStdoutStderr(result: ToolResult, maxChars: number): { stdout?: string; stderr?: string } {
  const output = asText(result.output ?? result.metadata?.output);
  const error = asText(result.error);
  const stderrMatch = output.match(/\[stderr\]:\s*([\s\S]*)$/i);
  const stdout = stderrMatch ? output.slice(0, stderrMatch.index).trim() : output;
  const stderr = [stderrMatch?.[1] ?? '', error].filter(Boolean).join('\n');
  return {
    stdout: stdout ? clampText(stdout, maxChars) : undefined,
    stderr: stderr ? clampText(stderr, maxChars) : undefined,
  };
}

function extractCwdFromContent(content: string): string | undefined {
  const match = content.match(/^\[cwd:\s*([^\]]+)\]/m);
  return match?.[1]?.trim();
}

function extractShellCommands(
  message: SurvivorManifestMessage,
  messageId: string,
  content: string,
  maxChars: number
): SurvivorShellCommandSummary[] {
  const calls = getToolCalls(message).filter((call) => toolCallCommand(call));
  const results = getToolResults(message);
  const byId = new Map(results.map((result) => [result.toolCallId, result]));

  if (calls.length > 0) {
    return calls.map((call) => {
      const result = byId.get(call.id);
      const split = result ? splitStdoutStderr(result, maxChars) : {};
      return {
        messageId,
        command: toolCallCommand(call) || call.name,
        cwd: toolCallCwd(call),
        exitCode: result ? resultExitCode(result) : undefined,
        success: result?.success,
        stdoutSummary: split.stdout,
        stderrSummary: split.stderr,
        errorSummary: result?.error ? clampText(result.error, maxChars) : undefined,
      };
    });
  }

  if (message.role === 'tool' && content) {
    const commandMatch = content.match(/(?:^\$|^command:)\s*(.+)$/im);
    const command = commandMatch?.[1]?.trim();
    if (command) {
      return [
        {
          messageId,
          command,
          cwd: extractCwdFromContent(content),
          stdoutSummary: clampText(content, maxChars),
        },
      ];
    }
  }
  return [];
}

function extractMatchingLines(content: string, re: RegExp, maxChars: number): string[] {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => re.test(line));
  return lines.slice(0, 12).map((line) => clampText(line, maxChars));
}

function collectArtifacts(
  message: SurvivorManifestMessage,
  messageId: string,
  content: string,
  artifacts: SurvivorArtifactSummary[],
  seenArtifacts: Set<string>
): void {
  for (const result of getToolResults(message)) {
    if (result.outputPath) {
      const path = stripPathPunctuation(result.outputPath);
      if (!seenArtifacts.has(path)) {
        seenArtifacts.add(path);
        artifacts.push({ messageId, path, source: 'tool_result' });
      }
    }
    const metaPaths: string[] = [];
    const seenMetaPaths = new Set<string>();
    collectPathValue(result.metadata, metaPaths, seenMetaPaths);
    for (const path of metaPaths) {
      if (!seenArtifacts.has(path)) {
        seenArtifacts.add(path);
        artifacts.push({ messageId, path, source: 'metadata' });
      }
    }
  }

  const messageArtifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
  for (const artifact of messageArtifacts) {
    for (const path of extractAbsoluteFilePaths(asText(artifact.content))) {
      if (!seenArtifacts.has(path)) {
        seenArtifacts.add(path);
        artifacts.push({ messageId, path, source: 'artifact' });
      }
    }
  }

  for (const line of content.split('\n')) {
    if (!/\b(?:artifact|output|saved|written|exported)\b/i.test(line)) continue;
    for (const path of extractAbsoluteFilePaths(line)) {
      if (!seenArtifacts.has(path)) {
        seenArtifacts.add(path);
        artifacts.push({ messageId, path, source: 'message' });
      }
    }
  }
}

interface FileCandidate {
  path: string;
  reasons: string[];
  messageIds: string[];
  observedText?: string;
  truncated?: boolean;
}

function rememberFileCandidate(
  candidates: Map<string, FileCandidate>,
  filePath: string | undefined,
  reason: string,
  messageId?: string,
  observedText?: string,
  truncated?: boolean,
): void {
  const normalized = normalizePathLike(filePath);
  if (!normalized) return;
  const existing = candidates.get(normalized) ?? {
    path: normalized,
    reasons: [],
    messageIds: [],
  };
  if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  if (messageId && !existing.messageIds.includes(messageId)) existing.messageIds.push(messageId);
  if (observedText && !existing.observedText) {
    existing.observedText = observedText;
    existing.truncated = truncated;
  }
  candidates.set(normalized, existing);
}

function collectReadToolCandidates(
  message: SurvivorManifestMessage,
  messageId: string,
  candidates: Map<string, FileCandidate>,
  filePaths: string[],
  seenPaths: Set<string>,
): void {
  const calls = getToolCalls(message).filter((call) => readToolPath(call));
  if (calls.length === 0) return;
  const results = getToolResults(message);
  const byId = new Map(results.map((result) => [result.toolCallId, result]));

  for (const call of calls) {
    const filePath = readToolPath(call);
    uniquePush(filePaths, seenPaths, filePath);
    const result = byId.get(call.id);
    const output = asText(result?.output ?? result?.metadata?.output);
    const truncated = /\n\.\.\. \(\d+ more lines\)\s*$/i.test(output);
    const observedText = result?.success === false ? undefined : removeReadLineNumbers(output);
    rememberFileCandidate(
      candidates,
      filePath,
      observedText ? 'read_file_observed_text' : 'read_file_reference',
      messageId,
      observedText,
      truncated,
    );
  }
}

function buildFileSurvivorRecords(
  filePaths: string[],
  candidates: Map<string, FileCandidate>,
  options: SurvivorManifestBuildOptions,
): SurvivorFileRecord[] {
  const readRecords = new Map(
    (options.fileReadRecords ?? []).map((record) => [path.resolve(record.path), record]),
  );
  const excerptMax = Math.max(80, options.maxFileExcerptChars ?? DEFAULT_MAX_FILE_EXCERPT_CHARS);
  let remainingExcerptChars = Math.max(
    0,
    options.maxFileExcerptTotalChars ?? DEFAULT_MAX_FILE_EXCERPT_TOTAL_CHARS,
  );

  return filePaths.map((rawPath) => {
    const normalized = path.resolve(rawPath);
    const candidate = candidates.get(normalized);
    const readRecord = readRecords.get(normalized);
    const observedText = candidate?.observedText;
    const size = readRecord?.size;
    const sensitive = hasSensitiveRisk(normalized, observedText);
    const textLike = isTextLikePath(normalized);
    const tooLarge = typeof size === 'number' && size > LARGE_FILE_BYTES;
    const safeForExcerpt = Boolean(observedText) && textLike && !tooLarge && !sensitive;
    const lastKnownReason = candidate?.reasons[0] ?? 'absolute_path_reference';
    const metadata: SurvivorFileMetadata = {
      size,
      mtime: readRecord?.mtime,
      readTime: readRecord?.readTime,
      textLike,
      truncated: candidate?.truncated,
      sensitive: sensitive || undefined,
    };

    const record: SurvivorFileRecord = {
      path: rawPath,
      reason: lastKnownReason,
      lastKnownReason,
      needsReRead: true,
      survival: 'path_only',
      metadata,
      messageIds: candidate?.messageIds.length ? candidate.messageIds : undefined,
    };

    if (!safeForExcerpt || !observedText) return record;
    const normalizedObserved = normalizeWhitespace(observedText);
    if (!normalizedObserved) return record;
    record.digest = digestText(normalizedObserved);
    record.survival = 'digest';

    if (remainingExcerptChars > 0) {
      const excerptBudget = Math.min(excerptMax, remainingExcerptChars);
      record.excerpt = clampText(normalizedObserved, excerptBudget);
      record.survival = 'excerpt';
      remainingExcerptChars -= record.excerpt.length;
    }

    return record;
  });
}

function compactIds(messages: SurvivorManifestMessage[], preserveRecentCount: number): {
  compactedMessageIds: string[];
  preservedMessageIds: string[];
} {
  const cutoff = Math.max(0, messages.length - preserveRecentCount);
  const compactedMessageIds: string[] = [];
  const preservedMessageIds: string[] = [];
  messages.forEach((message, index) => {
    const id = getMessageId(message, index);
    if (index >= cutoff) {
      preservedMessageIds.push(id);
    } else {
      compactedMessageIds.push(id);
    }
  });
  return { compactedMessageIds, preservedMessageIds };
}

function enforceManifestBudget(manifest: ContextSurvivorManifest, options: SurvivorManifestBuildOptions): ContextSurvivorManifest {
  const maxChars = manifestBudget(options);
  if (maxChars === undefined) return manifest;

  const copy: ContextSurvivorManifest = {
    ...manifest,
    commands: manifest.commands.map((command) => ({ ...command })),
    errors: manifest.errors.map((error) => ({ ...error })),
    todos: manifest.todos.map((todo) => ({ ...todo })),
    openWork: manifest.openWork.map((todo) => ({ ...todo })),
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact })),
    archivedToolResults: manifest.archivedToolResults.map((archive) => ({ ...archive })),
    filePaths: [...manifest.filePaths],
    files: manifest.files.map((file) => ({ ...file })),
  };

  while (JSON.stringify(copy).length > maxChars) {
    if (copy.commands.length > 0) {
      copy.commands.pop();
    } else if (copy.errors.length > 0) {
      copy.errors.pop();
    } else if (copy.todos.length > 0) {
      copy.todos.pop();
    } else if (copy.openWork.length > 0) {
      copy.openWork.pop();
    } else if (copy.artifacts.length > 0) {
      copy.artifacts.pop();
    } else if (copy.archivedToolResults.length > 0) {
      copy.archivedToolResults.pop();
    } else if (copy.filePaths.length > 0) {
      copy.filePaths.pop();
      copy.files.pop();
    } else if (copy.dataFingerprintText) {
      copy.dataFingerprintText = clampText(copy.dataFingerprintText, Math.max(0, Math.floor(maxChars / 2)));
      copy.dataFingerprint = copy.dataFingerprintText;
    } else {
      break;
    }
  }
  return copy;
}

function normalizeArchiveRef(ref: ToolResultArchiveRef): SurvivorArchivedToolResultSummary {
  return {
    artifactId: ref.artifactId,
    filePath: ref.filePath,
    toolName: ref.toolName,
    sessionId: ref.sessionId,
    sha256: ref.sha256,
    bytes: ref.bytes,
    reason: ref.reason,
    ...(ref.toolCallId ? { toolCallId: ref.toolCallId } : {}),
    ...(ref.sourceMessageId ? { sourceMessageId: ref.sourceMessageId } : {}),
  };
}

function dedupeArchivedToolResults(refs: ToolResultArchiveRef[] | undefined): SurvivorArchivedToolResultSummary[] {
  const archivedToolResults: SurvivorArchivedToolResultSummary[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    if (!ref?.artifactId || seen.has(ref.artifactId)) continue;
    seen.add(ref.artifactId);
    archivedToolResults.push(normalizeArchiveRef(ref));
  }
  return archivedToolResults;
}

export function buildContextSurvivorManifest(
  messages: SurvivorManifestMessage[],
  options: SurvivorManifestBuildOptions = {}
): ContextSurvivorManifest {
  const preserveRecentCount = Math.max(0, options.preserveRecentCount ?? DEFAULT_PRESERVE_RECENT_COUNT);
  const inferredIds = compactIds(messages, preserveRecentCount);
  const compactedMessageIds = options.compactedMessageIds ?? inferredIds.compactedMessageIds;
  const preservedMessageIds = options.preservedMessageIds ?? inferredIds.preservedMessageIds;
  const maxChars = itemBudget(options);

  const filePaths: string[] = [];
  const seenPaths = new Set<string>();
  const commands: SurvivorShellCommandSummary[] = [];
  const errors: SurvivorTextItem[] = [];
  const todos: SurvivorTextItem[] = [];
  const artifacts: SurvivorArtifactSummary[] = [];
  const seenArtifacts = new Set<string>();
  const fileCandidates = new Map<string, FileCandidate>();

  messages.forEach((message, index) => {
    const messageId = getMessageId(message, index);
    const content = getMessageContent(message);

    for (const path of extractAbsoluteFilePaths(content)) {
      uniquePush(filePaths, seenPaths, path);
      rememberFileCandidate(fileCandidates, path, 'absolute_path_reference', messageId);
    }
    for (const attachment of message.attachments || []) {
      collectPathValue(attachment.path, filePaths, seenPaths);
      collectPathValue(attachment.files, filePaths, seenPaths);
    }
    for (const result of getToolResults(message)) {
      collectPathValue(result.outputPath, filePaths, seenPaths);
      collectPathValue(result.metadata, filePaths, seenPaths);
      collectPathValue(result.output, filePaths, seenPaths);
      collectPathValue(result.error, filePaths, seenPaths);
    }
    collectReadToolCandidates(message, messageId, fileCandidates, filePaths, seenPaths);

    commands.push(...extractShellCommands(message, messageId, content, maxChars));

    for (const line of extractMatchingLines(content, ERROR_RE, maxChars)) {
      errors.push({ messageId, text: line });
    }
    for (const result of getToolResults(message)) {
      const errorText = [result.metadata?.output, result.error].filter(Boolean).map(asText).join('\n');
      for (const line of extractMatchingLines(errorText, ERROR_RE, maxChars)) {
        errors.push({ messageId, text: line });
      }
    }

    for (const line of extractMatchingLines(content, TODO_RE, maxChars)) {
      todos.push({ messageId, text: line });
    }

    collectArtifacts(message, messageId, content, artifacts, seenArtifacts);
  });
  for (const artifact of artifacts) {
    rememberFileCandidate(fileCandidates, artifact.path, `artifact_${artifact.source}`, artifact.messageId);
  }

  const manifest: ContextSurvivorManifest = {
    sessionId: options.sessionId,
    source: options.source,
    anchorMessageId: options.anchorMessageId,
    preserveRecentCount,
    compactedMessageIds,
    preservedMessageIds,
    filePaths,
    files: buildFileSurvivorRecords(filePaths, fileCandidates, options),
    commands,
    errors,
    todos,
    openWork: todos,
    artifacts,
    archivedToolResults: dedupeArchivedToolResults(options.archivedToolResults),
    dataFingerprintText: clampText(options.dataFingerprintText || '', maxChars),
  };
  manifest.dataFingerprint = manifest.dataFingerprintText;

  return enforceManifestBudget(manifest, options);
}

export function buildSurvivorManifest(input: BuildSurvivorManifestInput): ContextSurvivorManifest;
export function buildSurvivorManifest(
  messages: SurvivorManifestMessage[],
  options?: SurvivorManifestBuildOptions
): ContextSurvivorManifest;
export function buildSurvivorManifest(
  input: BuildSurvivorManifestInput | SurvivorManifestMessage[],
  options: SurvivorManifestBuildOptions = {}
): ContextSurvivorManifest {
  if (Array.isArray(input)) {
    return buildContextSurvivorManifest(input, options);
  }
  const { messages, ...inputOptions } = input;
  return buildContextSurvivorManifest(messages, inputOptions);
}

export function compactMessagesForSummary(
  messages: SurvivorManifestMessage[],
  options: CompactMessagesForSummaryOptions = {}
): Array<{ id?: string; role: string; content: string }> {
  const maxContentChars = Math.max(40, options.maxContentChars ?? options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS);
  const compacted = messages.map((message) => ({
    id: message.id,
    role: String(message.role ?? 'unknown'),
    content: clampText(getMessageContent(message), maxContentChars),
  }));
  return enforceSummaryMessageBudget(compacted, options.maxTotalTokens);
}

function summaryMessageTokenCost(message: { id?: string; role: string; content: string }): number {
  return estimateTokens(`[${message.role}${message.id ? ` ${message.id}` : ''}]: ${message.content}\n\n---\n\n`);
}

function renderSummaryMessagesForBudget(messages: Array<{ id?: string; role: string; content: string }>): string {
  return messages
    .map((message) => `[${message.role}${message.id ? ` ${message.id}` : ''}]: ${message.content}`)
    .join('\n\n---\n\n');
}

function totalSummaryMessageTokens(messages: Array<{ id?: string; role: string; content: string }>): number {
  return estimateTokens(renderSummaryMessagesForBudget(messages));
}

function enforceSummaryMessageBudget(
  messages: Array<{ id?: string; role: string; content: string }>,
  maxTotalTokens?: number,
): Array<{ id?: string; role: string; content: string }> {
  if (!maxTotalTokens || maxTotalTokens <= 0) return messages;
  const budget = Math.max(200, Math.floor(maxTotalTokens));
  if (totalSummaryMessageTokens(messages) <= budget) return messages;

  const head: Array<{ id?: string; role: string; content: string }> = [];
  const tail: Array<{ id?: string; role: string; content: string }> = [];
  const headBudget = Math.floor(budget * 0.35);
  let usedHead = 0;
  let headIndex = 0;

  while (headIndex < messages.length) {
    const cost = summaryMessageTokenCost(messages[headIndex]);
    if (usedHead + cost > headBudget) break;
    head.push(messages[headIndex]);
    usedHead += cost;
    headIndex += 1;
  }

  const marker = (omittedCount: number) => ({
    id: 'compaction-transcript-budget-marker',
    role: 'system',
    content: [
      `${omittedCount} compacted messages omitted from the transcript because the summary input hit its token budget.`,
      'Use the Context Survivor Manifest for retained files, commands, errors, artifacts, and open work.',
    ].join(' '),
  });

  let tailIndex = messages.length - 1;
  let usedTail = 0;
  while (tailIndex >= headIndex) {
    const omittedIfAdded = tailIndex - headIndex;
    const markerCost = summaryMessageTokenCost(marker(Math.max(0, omittedIfAdded)));
    const cost = summaryMessageTokenCost(messages[tailIndex]);
    if (usedHead + usedTail + markerCost + cost > budget) break;
    tail.unshift(messages[tailIndex]);
    usedTail += cost;
    tailIndex -= 1;
  }

  const omittedCount = messages.length - head.length - tail.length;
  if (omittedCount <= 0) return [...head, ...tail];

  let result = [...head, marker(omittedCount), ...tail];
  while (totalSummaryMessageTokens(result) > budget && tail.length > 0) {
    tail.shift();
    result = [...head, marker(messages.length - head.length - tail.length), ...tail];
  }
  while (totalSummaryMessageTokens(result) > budget && head.length > 0) {
    head.pop();
    result = [...head, marker(messages.length - head.length - tail.length), ...tail];
  }
  return result;
}

function renderList(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`## ${title}`);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

export function renderSurvivorManifestForPrompt(manifest: ContextSurvivorManifest): string {
  const lines: string[] = ['# Context Survivor Manifest'];
  const header: string[] = [];
  if (manifest.sessionId) header.push(`sessionId=${manifest.sessionId}`);
  if (manifest.source) header.push(`source=${manifest.source}`);
  if (manifest.anchorMessageId) header.push(`anchorMessageId=${manifest.anchorMessageId}`);
  header.push(`preserveRecentCount=${manifest.preserveRecentCount}`);
  lines.push(header.join(' '));

  renderList(lines, 'Compacted Message IDs', manifest.compactedMessageIds);
  renderList(lines, 'Preserved Message IDs', manifest.preservedMessageIds);
  renderList(lines, 'File Paths', manifest.filePaths);

  if (manifest.files.length > 0) {
    lines.push('## File Survivor Records');
    for (const file of manifest.files) {
      const meta = [
        `survival=${file.survival}`,
        file.needsReRead ? 'needsReRead=true' : undefined,
        file.lastKnownReason ? `reason=${file.lastKnownReason}` : undefined,
        file.digest ? `digest=${file.digest}` : undefined,
        file.metadata?.size !== undefined ? `size=${file.metadata.size}` : undefined,
        file.metadata?.truncated ? 'truncated=true' : undefined,
        file.metadata?.sensitive ? 'sensitive=true' : undefined,
      ].filter(Boolean).join(' ');
      lines.push(`- ${file.path}${meta ? ` (${meta})` : ''}`);
      if (file.excerpt) lines.push(`  excerpt: ${file.excerpt}`);
    }
  }

  if (manifest.commands.length > 0) {
    lines.push('## Shell Commands');
    for (const command of manifest.commands) {
      const meta = [
        command.messageId ? `message=${command.messageId}` : undefined,
        command.cwd ? `cwd=${command.cwd}` : undefined,
        command.exitCode !== undefined ? `exit=${command.exitCode}` : undefined,
        command.success !== undefined ? `success=${command.success}` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`- ${command.command}${meta ? ` (${meta})` : ''}`);
      if (command.stdoutSummary) lines.push(`  stdout: ${command.stdoutSummary}`);
      if (command.stderrSummary) lines.push(`  stderr: ${command.stderrSummary}`);
      if (command.errorSummary) lines.push(`  error: ${command.errorSummary}`);
    }
  }

  if (manifest.errors.length > 0) {
    lines.push('## Errors');
    for (const error of manifest.errors) {
      lines.push(`- ${error.messageId ? `[${error.messageId}] ` : ''}${error.text}`);
    }
  }

  if (manifest.todos.length > 0) {
    lines.push('## Todos');
    for (const todo of manifest.todos) {
      lines.push(`- ${todo.messageId ? `[${todo.messageId}] ` : ''}${todo.text}`);
    }
  }

  if (manifest.artifacts.length > 0) {
    lines.push('## Artifacts');
    for (const artifact of manifest.artifacts) {
      lines.push(`- ${artifact.path} (${artifact.source}${artifact.messageId ? `, message=${artifact.messageId}` : ''})`);
    }
  }

  if (manifest.archivedToolResults.length > 0) {
    lines.push('## Archived Tool Results');
    for (const archive of manifest.archivedToolResults) {
      const meta = [
        `tool=${archive.toolName}`,
        `reason=${archive.reason}`,
        archive.sourceMessageId ? `message=${archive.sourceMessageId}` : undefined,
        archive.toolCallId ? `toolCall=${archive.toolCallId}` : undefined,
        `bytes=${archive.bytes}`,
        `sha256=${archive.sha256.slice(0, 12)}`,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`- ${archive.artifactId} (${meta})`);
      lines.push(`  path: ${archive.filePath}`);
      lines.push(`  recover: read_tool_result_archive artifact_id=${archive.artifactId}`);
    }
  }

  if (manifest.dataFingerprintText) {
    lines.push('## Data Fingerprint');
    lines.push(manifest.dataFingerprintText);
  }

  return lines.join('\n');
}
