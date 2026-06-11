import type { Message } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import {
  collectExactFormLiterals,
  createCheckpointTemplate,
  renderVerbatimBlockQuote,
  replaceSectionBody,
  shouldUpdateActiveIntent,
  validateCheckpointDocument,
  type CheckpointPathTable,
} from '../context/checkpoint';
import {
  ensureCheckpointStore,
  readCheckpointStore,
  resolveCheckpointStorePaths,
  writeCheckpointFile,
  type CheckpointStorePaths,
} from '../context/checkpoint/store';

const logger = createLogger('CheckpointWriterAgent');

export interface CheckpointWriterJob {
  sessionId: string;
  workingDirectory: string;
  messages: Message[];
  reason: 'periodic' | 'pressure' | 'manual' | 'test';
  rootDir?: string;
  now?: number;
}

export interface CheckpointWriterResult {
  success: boolean;
  checkpointPath: string;
  memoryPath: string;
  error?: string;
  writtenAt: number;
}

function lastUserMessage(messages: readonly Message[]): Message | undefined {
  return [...messages].reverse().find((message) => message.role === 'user' && message.content.trim());
}

function lastAssistantMessage(messages: readonly Message[]): Message | undefined {
  return [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
}

function firstUserMessage(messages: readonly Message[]): Message | undefined {
  return messages.find((message) => message.role === 'user' && message.content.trim());
}

function extractToolFiles(messages: readonly Message[]): string[] {
  const files = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const args = call.arguments as Record<string, unknown> | undefined;
      const pathValue = args?.file_path ?? args?.path ?? args?.cwd;
      if (typeof pathValue === 'string' && pathValue.trim()) {
        files.add(pathValue.trim());
      }
    }
  }
  return [...files].slice(0, 20);
}

function relativeOrLabel(filePath: string, workingDirectory: string): string {
  if (!filePath.startsWith('/')) return filePath;
  if (filePath.startsWith(`${workingDirectory}/`)) {
    return filePath.slice(workingDirectory.length + 1);
  }
  return '[absolute path withheld by checkpoint path discipline]';
}

function summarizeText(text: string, maxChars = 700): string {
  const cleaned = text.trim();
  if (!cleaned) return '(none)';
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars)}...`;
}

function pathTable(paths: CheckpointStorePaths): CheckpointPathTable {
  return {
    CHECKPOINT_PATH: paths.checkpointPath,
    MEMORY_PATH: paths.memoryPath,
    TASK_MEM_DIR: paths.taskMemoryDir,
    NOTES_PATH: paths.notesPath,
  };
}

function renderExactDirectives(messages: readonly Message[]): string {
  const exact = messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => collectExactFormLiterals(message.content));
  if (exact.length === 0) return '(none)';
  return exact
    .map((item) => `- Preserve exact ${item.kind}: ${item.literal}`)
    .join('\n');
}

function buildCheckpoint(job: CheckpointWriterJob, previousCheckpoint: string): string {
  const latestUser = lastUserMessage(job.messages);
  const firstUser = firstUserMessage(job.messages);
  const activeIntentSource = latestUser && shouldUpdateActiveIntent(latestUser.content)
    ? latestUser
    : firstUser;
  const activeIntent = activeIntentSource
    ? renderVerbatimBlockQuote(activeIntentSource.content)
    : '(none)';
  const nextAction = latestUser && shouldUpdateActiveIntent(latestUser.content)
    ? [
      'Continue the active requested implementation.',
      renderVerbatimBlockQuote(latestUser.content),
    ].join('\n')
    : '(none)';
  const lastAssistant = lastAssistantMessage(job.messages);
  const files = extractToolFiles(job.messages)
    .map((filePath) => `- ${relativeOrLabel(filePath, job.workingDirectory)} - referenced by tool trajectory`)
    .join('\n') || '(none)';
  const checkpoint = previousCheckpoint.trim()
    ? previousCheckpoint
    : createCheckpointTemplate();

  let next = checkpoint;
  next = replaceSectionBody(next, 1, activeIntent);
  next = replaceSectionBody(next, 2, nextAction);
  next = replaceSectionBody(next, 3, renderExactDirectives(job.messages));
  next = replaceSectionBody(next, 4, '(none)');
  next = replaceSectionBody(
    next,
    5,
    lastAssistant
      ? `Last assistant work before checkpoint:\n${summarizeText(lastAssistant.content)}`
      : '(none)',
  );
  next = replaceSectionBody(next, 6, files);
  next = replaceSectionBody(next, 7, '(none)');
  next = replaceSectionBody(next, 8, '(none)');
  next = replaceSectionBody(
    next,
    9,
    [
      `- sessionId: ${job.sessionId}`,
      `- reason: ${job.reason}`,
      `- writtenAt: ${job.now ?? Date.now()}`,
    ].join('\n'),
  );
  next = replaceSectionBody(next, 10, '(none)');
  next = replaceSectionBody(next, 11, '(none)');
  return next;
}

export async function runCheckpointWriterAgent(job: CheckpointWriterJob): Promise<CheckpointWriterResult> {
  const writtenAt = job.now ?? Date.now();
  const paths = resolveCheckpointStorePaths(job);
  try {
    await ensureCheckpointStore(paths);
    const current = await readCheckpointStore(paths);
    const checkpoint = buildCheckpoint({ ...job, now: writtenAt }, current.checkpoint);
    const exactLiterals = job.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => collectExactFormLiterals(message.content));
    const validation = validateCheckpointDocument(checkpoint, {
      requiredExactLiterals: exactLiterals,
      pathTable: pathTable(paths),
    });
    if (!validation.valid) {
      throw new Error(`checkpoint validation failed: ${JSON.stringify(validation)}`);
    }
    await writeCheckpointFile(paths.checkpointPath, checkpoint);
    return {
      success: true,
      checkpointPath: paths.checkpointPath,
      memoryPath: paths.memoryPath,
      writtenAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[CheckpointWriterAgent] checkpoint write failed', {
      sessionId: job.sessionId,
      reason: job.reason,
      error: message,
    });
    return {
      success: false,
      checkpointPath: paths.checkpointPath,
      memoryPath: paths.memoryPath,
      error: message,
      writtenAt,
    };
  }
}

