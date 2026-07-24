// ============================================================================
// Completion Summary Service
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { getUserConfigDir } from '../config/configPaths';
import type { RuntimeContext } from '../agent/runtime/runtimeContext';
import type {
  CompletionSummaryArtifactRef,
  CompletionSummaryCommand,
  CompletionSummaryDirtyState,
  CompletionSummaryRecord,
  CompletionSummaryStatus,
  CompletionSummaryVerificationEvidence,
  Message,
  ToolCall,
  ToolResult,
} from '../../shared/contract';
import { resolveWorkspacePath } from '../runtime/workspaceScope';
import { getProjectSourceGitStates } from '../services/git/gitStatusService';

const execFileAsync = promisify(execFile);

const COMPLETION_SUMMARY_FILE = 'completion-summaries.jsonl';
const MAX_OBJECTIVE_LENGTH = 500;
const MAX_PREVIEW_LENGTH = 500;
const MAX_RECORDS_TO_READ = 100;

export interface BuildCompletionSummaryInput {
  ctx: RuntimeContext;
  status: CompletionSummaryStatus;
  iterations: number;
  userMessage: string;
  error?: unknown;
}

function getCompletionSummaryPath(): string {
  return path.join(getUserConfigDir(), COMPLETION_SUMMARY_FILE);
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 16).trimEnd()}...[truncated]`
    : normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeHandoffText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizePath(value: string | undefined, workingDirectory: string): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(workingDirectory, trimmed);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function parseExitCode(result: ToolResult): number | null | undefined {
  const metaExitCode = result.metadata?.exitCode;
  if (typeof metaExitCode === 'number') return metaExitCode;
  if (typeof metaExitCode === 'string' && /^-?\d+$/.test(metaExitCode)) return Number(metaExitCode);

  const text = `${result.error ?? ''}\n${result.output ?? ''}`;
  const match = text.match(/(?:exit(?:ed)?(?: with)? code|Command exited with code)\s+(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function isVerificationCommand(command: string): boolean {
  return /\b(vitest|jest|playwright|npm\s+run\s+(typecheck|test|lint|build|release:security-scan|debt:report)|npm\s+test|pnpm\s+(test|lint|build)|yarn\s+(test|lint|build)|tsc|cargo\s+test|go\s+test|pytest|git\s+diff\s+--check|madge)\b/i.test(command);
}

function mapToolResults(messages: Message[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      results.set(result.toolCallId, result);
    }
  }
  return results;
}

function collectToolCalls(messages: Message[]): ToolCall[] {
  return messages.flatMap((message) => message.toolCalls ?? []);
}

function collectCommands(messages: Message[]): CompletionSummaryCommand[] {
  const results = mapToolResults(messages);
  return collectToolCalls(messages)
    .filter((toolCall) => toolCall.name === 'Bash' || toolCall.name === 'bash')
    .map((toolCall) => {
      const result = results.get(toolCall.id);
      const command = typeof toolCall.arguments?.command === 'string'
        ? toolCall.arguments.command
        : '';
      const cwd = typeof result?.metadata?.cwd === 'string'
        ? result.metadata.cwd
        : undefined;
      const exitCode = result ? parseExitCode(result) : undefined;
      const outputPreview = compactText(result?.output ?? result?.error, MAX_PREVIEW_LENGTH);
      return {
        toolCallId: toolCall.id,
        command,
        cwd,
        success: result?.success ?? false,
        exitCode,
        durationMs: result?.duration,
        verification: isVerificationCommand(command),
        outputPreview,
      };
    });
}

function collectVerificationEvidence(commands: CompletionSummaryCommand[]): CompletionSummaryVerificationEvidence[] {
  return commands
    .filter((command) => command.verification)
    .map((command) => ({
      kind: 'command',
      toolCallId: command.toolCallId,
      command: command.command,
      success: command.success,
      exitCode: command.exitCode,
      outputPreview: command.outputPreview,
    }));
}

function collectChangedFiles(ctx: RuntimeContext): string[] {
  const fromNudge = Array.from(ctx.nudgeManager.getModifiedFiles()).map((filePath) =>
    normalizePath(filePath, ctx.workingDirectory)
  );
  const fromResults = ctx.messages.flatMap((message) =>
    (message.toolResults ?? []).flatMap((result) => {
      const changedFiles = Array.isArray(result.metadata?.changedFiles)
        ? result.metadata.changedFiles.filter((item): item is string => typeof item === 'string')
        : [];
      const outputPath = typeof result.outputPath === 'string'
        ? result.outputPath
        : typeof result.metadata?.outputPath === 'string'
          ? result.metadata.outputPath
          : undefined;
      return [...changedFiles, outputPath].map((filePath) => normalizePath(filePath, ctx.workingDirectory));
    })
  );
  return uniqueStrings([...fromNudge, ...fromResults]);
}

function collectArtifactRefs(ctx: RuntimeContext): CompletionSummaryArtifactRef[] {
  const fromMessages = ctx.messages.flatMap((message) =>
    (message.artifacts ?? []).map((artifact) => ({
      kind: 'artifact' as const,
      messageId: message.id,
      artifactId: artifact.id,
      title: artifact.title,
    }))
  );
  const fromResults = ctx.messages.flatMap((message) =>
    (message.toolResults ?? []).flatMap((result) => {
      const outputPath = typeof result.outputPath === 'string'
        ? result.outputPath
        : typeof result.metadata?.outputPath === 'string'
          ? result.metadata.outputPath
          : undefined;
      const normalized = normalizePath(outputPath, ctx.workingDirectory);
      return normalized ? [{ kind: 'file' as const, path: normalized, messageId: message.id }] : [];
    })
  );
  return [...fromMessages, ...fromResults];
}

function getVisibleFinalAnswer(messages: Message[]): CompletionSummaryRecord['visibleFinalAnswer'] {
  const finalMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && !message.isMeta && !message.toolCalls?.length && message.content.trim());

  if (!finalMessage) return undefined;
  return {
    messageId: finalMessage.id,
    timestamp: finalMessage.timestamp,
    sha256: sha256(finalMessage.content),
    preview: compactText(finalMessage.content, MAX_PREVIEW_LENGTH) ?? '',
  };
}

function collectRisks(input: BuildCompletionSummaryInput, commands: CompletionSummaryCommand[]): string[] {
  const risks: string[] = [];
  if (input.status === 'failed' && input.error) {
    risks.push(compactText(input.error instanceof Error ? input.error.message : String(input.error), MAX_PREVIEW_LENGTH) ?? 'Runtime failed');
  }
  const failedVerification = commands.filter((command) => command.verification && !command.success);
  for (const command of failedVerification) {
    risks.push(`Verification command failed: ${command.command}`);
  }
  return uniqueStrings(risks);
}

function collectBlockers(input: BuildCompletionSummaryInput): string[] {
  if (input.status === 'failed' && input.error) {
    return [compactText(input.error instanceof Error ? input.error.message : String(input.error), MAX_PREVIEW_LENGTH) ?? 'Runtime failed'];
  }
  if (input.status === 'aborted') return ['Run aborted before completion contract could mark success'];
  if (input.status === 'cancelled') return ['Run cancelled'];
  if (input.status === 'interrupted') return ['Run interrupted'];
  return [];
}

function parsePorcelainChangedFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function readGitDirtyState(workingDirectory: string): Promise<CompletionSummaryDirtyState | undefined> {
  try {
    const [branchResult, headResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workingDirectory, timeout: 2000 }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory, timeout: 2000 }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: workingDirectory, timeout: 2000 }),
    ]);
    const changedFiles = parsePorcelainChangedFiles(statusResult.stdout);
    return {
      checkedAt: Date.now(),
      gitBranch: branchResult.stdout.trim() || null,
      headCommit: headResult.stdout.trim() || null,
      isDirty: changedFiles.length > 0,
      changedFiles,
    };
  } catch (error) {
    return {
      checkedAt: Date.now(),
      error: compactText(error instanceof Error ? error.message : String(error), MAX_PREVIEW_LENGTH),
    };
  }
}

export async function buildCompletionSummaryRecord(input: BuildCompletionSummaryInput): Promise<CompletionSummaryRecord> {
  const { ctx } = input;
  const endedAt = Date.now();
  const commands = collectCommands(ctx.messages);
  const changedFiles = collectChangedFiles(ctx);
  const visibleFinalAnswer = getVisibleFinalAnswer(ctx.messages);
  const dirtyState = await readGitDirtyState(ctx.workingDirectory);
  const workspaceScope = ctx.workspaceScope;
  const dirtyStates = workspaceScope
    ? (await getProjectSourceGitStates(workspaceScope)).map((state) => {
      const root = workspaceScope.roots.find((entry) => entry.sourceId === state.sourceId);
      if (!root) {
        throw new Error(`Git state references unknown Project Source: ${state.sourceId}`);
      }
      return {
        sourceId: state.sourceId,
        sourceRole: root.role,
        sourceAccess: root.access,
        repositoryRoot: state.repositoryRoot,
        checkedAt: endedAt,
        gitBranch: state.branch ?? null,
        headCommit: state.headSha ?? null,
        isDirty: Boolean(state.dirtyFiles?.length),
        changedFiles: state.dirtyFiles ?? [],
        ...(!state.isRepository ? { error: 'not-a-git-repository' } : {}),
      } satisfies CompletionSummaryDirtyState;
    })
    : undefined;
  const changedFilesBySource = workspaceScope
    ? workspaceScope.roots.map((root) => ({
      sourceId: root.sourceId,
      sourceRole: root.role,
      sourceAccess: root.access,
      files: changedFiles.filter((filePath) =>
        resolveWorkspacePath(workspaceScope, filePath, 'read')?.root.sourceId === root.sourceId
      ),
    })).filter((group) => group.files.length > 0)
    : undefined;
  const idSeed = `${ctx.sessionId}:${ctx.stats.traceId}:${endedAt}:${input.status}`;

  return {
    schemaVersion: 1,
    id: `completion_${endedAt}_${sha256(idSeed).slice(0, 8)}`,
    sessionId: ctx.sessionId,
    traceId: ctx.stats.traceId,
    agentId: ctx.agentId,
    objective: compactText(input.userMessage, MAX_OBJECTIVE_LENGTH) ?? '',
    status: input.status,
    startedAt: ctx.stats.runStartTime,
    endedAt,
    durationMs: Math.max(0, endedAt - ctx.stats.runStartTime),
    iterations: input.iterations,
    tokenUsage: {
      input: ctx.stats.totalInputTokens,
      output: ctx.stats.totalOutputTokens,
      total: ctx.stats.totalInputTokens + ctx.stats.totalOutputTokens,
    },
    toolCallCount: collectToolCalls(ctx.messages).length,
    changedFiles,
    commands,
    verificationEvidence: collectVerificationEvidence(commands),
    dirtyState,
    dirtyStates,
    changedFilesBySource,
    workspaceScopeVersion: ctx.workspaceScope?.version,
    commitIds: [],
    risks: collectRisks(input, commands),
    blockers: collectBlockers(input),
    artifactRefs: collectArtifactRefs(ctx),
    visibleFinalAnswer,
  };
}

export async function persistCompletionSummaryRecord(record: CompletionSummaryRecord): Promise<void> {
  const filePath = getCompletionSummaryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

async function readCompletionSummaryFile(): Promise<CompletionSummaryRecord[]> {
  try {
    const content = await fs.readFile(getCompletionSummaryPath(), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as CompletionSummaryRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function readRecentCompletionSummaryRecords(limit = MAX_RECORDS_TO_READ): Promise<CompletionSummaryRecord[]> {
  const records = await readCompletionSummaryFile();
  return records.slice(-limit).reverse();
}

export async function readCompletionSummaryRecordsBySession(
  sessionId: string,
  limit = MAX_RECORDS_TO_READ,
): Promise<CompletionSummaryRecord[]> {
  const records = await readCompletionSummaryFile();
  return records
    .filter((record) => record.sessionId === sessionId)
    .slice(-limit)
    .reverse();
}

export async function readLatestCompletionSummaryRecord(
  sessionId: string,
): Promise<CompletionSummaryRecord | null> {
  const [record] = await readCompletionSummaryRecordsBySession(sessionId, 1);
  return record ?? null;
}

export function formatCompletionSummaryForHandoff(record: CompletionSummaryRecord): string {
  const lines: string[] = [
    '<completion-summary>',
    `status: ${record.status}`,
    `objective: ${escapeHandoffText(record.objective || '(empty)')}`,
    `iterations: ${record.iterations}`,
    `tokens: ${record.tokenUsage.total}`,
  ];

  if (record.changedFiles.length > 0) {
    lines.push('changed_files:');
    for (const filePath of record.changedFiles.slice(0, 20)) {
      lines.push(`- ${escapeHandoffText(filePath)}`);
    }
  }

  if (record.verificationEvidence.length > 0) {
    lines.push('verification:');
    for (const evidence of record.verificationEvidence.slice(0, 10)) {
      lines.push(`- ${evidence.success ? 'pass' : 'fail'} exit=${evidence.exitCode ?? 'unknown'} command=${escapeHandoffText(evidence.command)}`);
    }
  }

  if (record.dirtyState) {
    lines.push(`dirty_state: ${record.dirtyState.isDirty === undefined ? 'unknown' : record.dirtyState.isDirty ? 'dirty' : 'clean'}`);
    if (record.dirtyState.gitBranch) lines.push(`git_branch: ${escapeHandoffText(record.dirtyState.gitBranch)}`);
    if (record.dirtyState.headCommit) lines.push(`head_commit: ${escapeHandoffText(record.dirtyState.headCommit)}`);
  }

  if (record.risks.length > 0) {
    lines.push('risks:');
    for (const risk of record.risks.slice(0, 10)) {
      lines.push(`- ${escapeHandoffText(risk)}`);
    }
  }

  if (record.blockers.length > 0) {
    lines.push('blockers:');
    for (const blocker of record.blockers.slice(0, 10)) {
      lines.push(`- ${escapeHandoffText(blocker)}`);
    }
  }

  if (record.visibleFinalAnswer) {
    lines.push(`visible_final_answer: message=${escapeHandoffText(record.visibleFinalAnswer.messageId)} sha256=${escapeHandoffText(record.visibleFinalAnswer.sha256)}`);
  }

  lines.push('</completion-summary>');
  return lines.join('\n');
}
