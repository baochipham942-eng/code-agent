import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStreamSnapshot,
  createSnapshotHandler,
  getIncompleteToolCallIds,
  getStreamSnapshotPath,
  loadStreamSnapshot,
  saveStreamSnapshot,
  type StreamSnapshotIdentity,
} from '../../../src/host/session/streamSnapshot';

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const partialSnapshot = (content: string, timestamp = 100) => ({
  content,
  reasoning: '',
  toolCalls: [],
  estimatedTokens: 1,
  timestamp,
  isFinal: false,
});

describe('stream snapshot run isolation', () => {
  let tempDir: string;

  const identity = (overrides: Partial<StreamSnapshotIdentity> = {}): StreamSnapshotIdentity => ({
    workingDir: tempDir,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ...overrides,
  });

  beforeEach(() => {
    loggerWarn.mockClear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-stream-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('isolates two sessions writing in the same workspace', () => {
    saveStreamSnapshot(partialSnapshot('session one'), identity());
    saveStreamSnapshot(partialSnapshot('session two'), identity({
      sessionId: 'session-2',
      runId: 'run-2',
      turnId: 'turn-2',
    }));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' })?.content)
      .toBe('session one');
    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-2' })?.content)
      .toBe('session two');
  });

  it('does not let an old run clear a newer run snapshot', () => {
    saveStreamSnapshot(partialSnapshot('old run', 100), identity({ runId: 'run-old' }));
    saveStreamSnapshot(partialSnapshot('new run', 200), identity({ runId: 'run-new' }));

    clearStreamSnapshot(identity({ runId: 'run-old' }));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' }))
      .toMatchObject({ runId: 'run-new', content: 'new run' });
  });

  it('rejects a stale terminal callback after a newer run becomes owner', () => {
    const oldHandler = createSnapshotHandler(identity({ runId: 'run-old' }));
    oldHandler(partialSnapshot('old partial', 100));
    const newHandler = createSnapshotHandler(identity({ runId: 'run-new' }));
    newHandler(partialSnapshot('new partial', 200));

    oldHandler({ ...partialSnapshot('old final', 300), isFinal: true });

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' }))
      .toMatchObject({ runId: 'run-new', content: 'new partial' });
  });

  it('does not collide when two runs start in the same millisecond', () => {
    saveStreamSnapshot(partialSnapshot('run one', 100), identity({ runId: 'run-1' }));
    saveStreamSnapshot(partialSnapshot('run two', 100), identity({ runId: 'run-2' }));

    expect(getStreamSnapshotPath(identity({ runId: 'run-1' })))
      .not.toBe(getStreamSnapshotPath(identity({ runId: 'run-2' })));
    expect(JSON.parse(fs.readFileSync(getStreamSnapshotPath(identity({ runId: 'run-1' })), 'utf8')))
      .toMatchObject({ runId: 'run-1', content: 'run one', timestamp: 100 });
    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1', runId: 'run-2' })?.content)
      .toBe('run two');
  });

  it('keeps incomplete tool calls as evidence but never restores them for execution', () => {
    saveStreamSnapshot(
      {
        ...partialSnapshot(''),
        toolCalls: [
          { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
        ],
      },
      identity(),
    );

    const snapshot = loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' });

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      workspace: fs.realpathSync(tempDir),
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['tool-1'],
      executionToolCalls: [],
    });
    expect(snapshot?.toolCalls).toHaveLength(1);
  });

  it('explicitly discards an unscoped legacy snapshot instead of attaching it to a session', () => {
    const legacyPath = path.join(tempDir, '.code-agent', 'stream-snapshot.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({
      ...partialSnapshot('legacy'),
      sessionId: 'session-1',
      turnId: 'turn-legacy',
    }));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' })).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(
      'Discarded legacy unscoped stream snapshot; run identity was unavailable',
    );
  });

  it('keeps the last valid snapshot readable when an orphan temp file is truncated', () => {
    const scopedIdentity = identity();
    saveStreamSnapshot(partialSnapshot('valid'), scopedIdentity);
    fs.writeFileSync(`${getStreamSnapshotPath(scopedIdentity)}.crashed.tmp`, '{');

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' })?.content)
      .toBe('valid');
  });

  it('redacts credentials from persisted tool arguments', () => {
    saveStreamSnapshot({
      ...partialSnapshot('Authorization: Bearer content-secret-token'),
      reasoning: 'api_key=reasoning-secret-key',
      toolCalls: [{
        id: 'tool-secret',
        name: 'http_request',
        arguments: JSON.stringify({
          apiKey: 'sk-test-secret-12345',
          headers: { Authorization: 'Bearer top-secret-token' },
        }),
      }],
    }, identity());

    const persisted = fs.readFileSync(getStreamSnapshotPath(identity()), 'utf8');
    expect(persisted).not.toContain('sk-test-secret-12345');
    expect(persisted).not.toContain('top-secret-token');
    expect(persisted).not.toContain('content-secret-token');
    expect(persisted).not.toContain('reasoning-secret-key');
    expect(persisted).toContain('***REDACTED***');
  });

  it('does not report incomplete ids for final snapshots', () => {
    expect(getIncompleteToolCallIds({
      isFinal: true,
      toolCalls: [
        { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
      ],
    })).toEqual([]);
  });
});
