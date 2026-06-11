import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { getUserDataPath } from '../../platform/appPaths';
import {
  createCheckpointTemplate,
  MEMORY_TEMPLATE,
  NOTES_TEMPLATE,
} from './templates';

export interface CheckpointStoreInput {
  sessionId: string;
  workingDirectory: string;
  rootDir?: string;
}

export interface CheckpointStorePaths {
  rootDir: string;
  projectDir: string;
  sessionDir: string;
  checkpointPath: string;
  memoryPath: string;
  notesPath: string;
  taskMemoryDir: string;
}

function projectKey(workingDirectory: string): string {
  return createHash('sha1').update(path.resolve(workingDirectory)).digest('hex').slice(0, 16);
}

export function resolveCheckpointStorePaths(input: CheckpointStoreInput): CheckpointStorePaths {
  const rootDir = input.rootDir ?? path.join(getUserDataPath(), 'checkpoint-rebuild');
  const projectDir = path.join(rootDir, 'projects', projectKey(input.workingDirectory));
  const sessionDir = path.join(projectDir, 'sessions', input.sessionId);
  return {
    rootDir,
    projectDir,
    sessionDir,
    checkpointPath: path.join(sessionDir, 'checkpoint.md'),
    memoryPath: path.join(projectDir, 'MEMORY.md'),
    notesPath: path.join(sessionDir, 'notes.md'),
    taskMemoryDir: path.join(sessionDir, 'tasks'),
  };
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

export async function ensureCheckpointStore(paths: CheckpointStorePaths): Promise<void> {
  await fs.mkdir(paths.taskMemoryDir, { recursive: true });
  await writeIfMissing(paths.checkpointPath, createCheckpointTemplate());
  await writeIfMissing(paths.memoryPath, MEMORY_TEMPLATE);
  await writeIfMissing(paths.notesPath, NOTES_TEMPLATE);
}

export async function readCheckpointStore(paths: CheckpointStorePaths): Promise<{
  checkpoint: string;
  memory: string;
  notes: string;
}> {
  await ensureCheckpointStore(paths);
  const [checkpoint, memory, notes] = await Promise.all([
    fs.readFile(paths.checkpointPath, 'utf-8'),
    fs.readFile(paths.memoryPath, 'utf-8'),
    fs.readFile(paths.notesPath, 'utf-8'),
  ]);
  return { checkpoint, memory, notes };
}

export async function readExistingCheckpointStore(paths: CheckpointStorePaths): Promise<{
  checkpoint: string;
  memory: string;
  notes: string;
} | null> {
  try {
    const [checkpoint, memory, notes] = await Promise.all([
      fs.readFile(paths.checkpointPath, 'utf-8'),
      fs.readFile(paths.memoryPath, 'utf-8').catch(() => MEMORY_TEMPLATE),
      fs.readFile(paths.notesPath, 'utf-8').catch(() => ''),
    ]);
    return { checkpoint, memory, notes };
  } catch {
    return null;
  }
}

export async function writeCheckpointFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}
