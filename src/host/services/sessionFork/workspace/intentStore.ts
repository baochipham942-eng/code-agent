import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { digestWorkspaceValue } from './anchorEvidence';
import type { WorkspaceForkIntent, WorkspaceForkIntentStore } from './types';

export class WorkspaceIntentStoreError extends Error {
  constructor(
    public readonly code:
      | 'INTENT_CONFLICT'
      | 'INTENT_NOT_FOUND'
      | 'INTENT_REVISION_CONFLICT'
      | 'INTENT_CORRUPT',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceIntentStoreError';
  }
}

function cloneIntent(intent: WorkspaceForkIntent): WorkspaceForkIntent {
  return structuredClone(intent);
}

function intentFileName(intentId: string): string {
  return `${digestWorkspaceValue(intentId)}.json`;
}

export class JsonWorkspaceForkIntentStore implements WorkspaceForkIntentStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDirectory: string) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new WorkspaceIntentStoreError('INTENT_CORRUPT', 'intent state directory must be absolute');
    }
  }

  async create(intent: WorkspaceForkIntent): Promise<WorkspaceForkIntent> {
    return await this.serialized(async () => {
      const existing = await this.readById(intent.intentId);
      if (existing) {
        if (existing.requestDigest !== intent.requestDigest) {
          throw new WorkspaceIntentStoreError(
            'INTENT_CONFLICT',
            `intent ${intent.intentId} already exists with another request`,
          );
        }
        return cloneIntent(existing);
      }
      await this.persist(intent);
      return cloneIntent(intent);
    });
  }

  async get(intentId: string): Promise<WorkspaceForkIntent | null> {
    return await this.serialized(async () => {
      const intent = await this.readById(intentId);
      return intent ? cloneIntent(intent) : null;
    });
  }

  async list(): Promise<WorkspaceForkIntent[]> {
    return await this.serialized(async () => {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.stateDirectory, 0o700);
      const entries = await readdir(this.stateDirectory, { withFileTypes: true });
      const intents: WorkspaceForkIntent[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp-')) continue;
        const parsed = await this.readFile(path.join(this.stateDirectory, entry.name));
        intents.push(parsed);
      }
      intents.sort((left, right) => left.createdAt - right.createdAt || left.intentId.localeCompare(right.intentId));
      return intents.map(cloneIntent);
    });
  }

  async update(
    intentId: string,
    expectedRevision: number,
    patch: Partial<Omit<WorkspaceForkIntent, 'intentId' | 'version' | 'revision' | 'createdAt'>>,
  ): Promise<WorkspaceForkIntent> {
    return await this.serialized(async () => {
      const current = await this.readById(intentId);
      if (!current) {
        throw new WorkspaceIntentStoreError('INTENT_NOT_FOUND', `intent ${intentId} does not exist`);
      }
      if (current.revision !== expectedRevision) {
        throw new WorkspaceIntentStoreError(
          'INTENT_REVISION_CONFLICT',
          `intent ${intentId} revision changed`,
        );
      }
      const next: WorkspaceForkIntent = {
        ...current,
        ...structuredClone(patch),
        version: 1,
        intentId: current.intentId,
        revision: current.revision + 1,
        createdAt: current.createdAt,
      };
      await this.persist(next);
      return cloneIntent(next);
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return await next;
  }

  private async readById(intentId: string): Promise<WorkspaceForkIntent | null> {
    const filePath = path.join(this.stateDirectory, intentFileName(intentId));
    try {
      const intent = await this.readFile(filePath);
      if (intent.intentId !== intentId) {
        throw new WorkspaceIntentStoreError('INTENT_CORRUPT', 'intent file identity does not match');
      }
      return intent;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readFile(filePath: string): Promise<WorkspaceForkIntent> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new WorkspaceIntentStoreError('INTENT_CORRUPT', `cannot read intent: ${String(error)}`);
    }
    const candidate = parsed as Partial<WorkspaceForkIntent>;
    if (
      candidate.version !== 1
      || typeof candidate.intentId !== 'string'
      || typeof candidate.requestDigest !== 'string'
      || typeof candidate.revision !== 'number'
      || typeof candidate.workspacePath !== 'string'
      || typeof candidate.status !== 'string'
      || !candidate.evidence
    ) {
      throw new WorkspaceIntentStoreError('INTENT_CORRUPT', `invalid intent file: ${filePath}`);
    }
    return candidate as WorkspaceForkIntent;
  }

  private async persist(intent: WorkspaceForkIntent): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
    const filePath = path.join(this.stateDirectory, intentFileName(intent.intentId));
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(intent)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const temporaryHandle = await open(temporaryPath, 'r');
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporaryPath, filePath);
    const directoryHandle = await open(this.stateDirectory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}
