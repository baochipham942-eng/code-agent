// ============================================================================
// AgentTask Tests
// State machine, transcript, pending messages, and persistence
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  AgentTask,
  InvalidStateTransitionError,
} from '../../../src/main/agent/agentTask';
import type { SidecarMetadata, TranscriptEntry } from '../../../src/main/agent/agentTask';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeMetadata(overrides?: Partial<SidecarMetadata>): SidecarMetadata {
  return {
    agentType: 'coder',
    parentSessionId: 'session-1',
    spawnTime: 1000,
    model: 'kimi-k2.5',
    toolPool: ['read_file', 'write_file'],
    ...overrides,
  };
}

function makeTask(id = 'task-1', overrides?: Partial<SidecarMetadata>): AgentTask {
  return new AgentTask(id, makeMetadata(overrides));
}

// --------------------------------------------------------------------------
// State Machine — valid transitions
// --------------------------------------------------------------------------

describe('AgentTask state machine — valid transitions', () => {
  it('pending → register', () => {
    const task = makeTask();
    expect(task.status).toBe('pending');
    task.register();
    expect(task.status).toBe('registered');
  });

  it('registered → start', () => {
    const task = makeTask();
    task.register();
    task.start();
    expect(task.status).toBe('running');
    expect(task.abortController).not.toBeNull();
  });

  it('running → stop', () => {
    const task = makeTask();
    task.register();
    task.start();
    task.stop();
    expect(task.status).toBe('stopped');
    expect(task.abortController).toBeNull();
  });

  it('stopped → resume', () => {
    const task = makeTask();
    task.register();
    task.start();
    task.stop();
    task.resume();
    expect(task.status).toBe('resumed');
  });

  it('resumed → start (re-entry)', () => {
    const task = makeTask();
    task.register();
    task.start();
    task.stop();
    task.resume();
    task.start();
    expect(task.status).toBe('running');
    expect(task.abortController).not.toBeNull();
  });

  it('running → fail', () => {
    const task = makeTask();
    task.register();
    task.start();
    task.fail('network error');
    expect(task.status).toBe('failed');
    expect(task.error).toBe('network error');
    expect(task.abortController).toBeNull();
  });

  it('cancel from running aborts controller', () => {
    const task = makeTask();
    task.register();
    task.start();
    const ctrl = task.abortController!;
    expect(ctrl.signal.aborted).toBe(false);
    task.cancel();
    expect(task.status).toBe('cancelled');
    expect(ctrl.signal.aborted).toBe(true);
    expect(task.abortController).toBeNull();
  });

  it('cancel from pending (no abort controller)', () => {
    const task = makeTask();
    task.cancel();
    expect(task.status).toBe('cancelled');
  });
});

// --------------------------------------------------------------------------
// State Machine — invalid transitions
// --------------------------------------------------------------------------

describe('AgentTask state machine — invalid transitions', () => {
  it('pending → start throws', () => {
    const task = makeTask();
    expect(() => task.start()).toThrowError(InvalidStateTransitionError);
  });

  it('pending → stop throws', () => {
    const task = makeTask();
    expect(() => task.stop()).toThrowError(InvalidStateTransitionError);
  });

  it('registered → stop throws', () => {
    const task = makeTask();
    task.register();
    expect(() => task.stop()).toThrowError(InvalidStateTransitionError);
  });

  it('running → register throws', () => {
    const task = makeTask();
    task.register();
    task.start();
    expect(() => task.register()).toThrowError(InvalidStateTransitionError);
  });

  it('stopped → start throws (must resume first)', () => {
    const task = makeTask();
    task.register();
    task.start();
    task.stop();
    expect(() => task.start()).toThrowError(InvalidStateTransitionError);
  });

  it('cancel from failed throws', () => {
    const task = makeTask();
    task.register();
    task.start();
    task.fail('err');
    expect(() => task.cancel()).toThrowError(InvalidStateTransitionError);
  });

  it('cancel from cancelled throws', () => {
    const task = makeTask();
    task.cancel();
    expect(() => task.cancel()).toThrowError(InvalidStateTransitionError);
  });

  it('error message contains from → to states', () => {
    const task = makeTask();
    let err: InvalidStateTransitionError | undefined;
    try {
      task.start();
    } catch (e) {
      err = e as InvalidStateTransitionError;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('pending');
    expect(err!.message).toContain('running');
    expect(err!.name).toBe('InvalidStateTransitionError');
  });
});

// --------------------------------------------------------------------------
// Transcript
// --------------------------------------------------------------------------

describe('AgentTask transcript', () => {
  it('starts empty', () => {
    const task = makeTask();
    expect(task.getTranscript()).toHaveLength(0);
  });

  it('appendTranscript adds entry', () => {
    const task = makeTask();
    const entry: TranscriptEntry = { role: 'user', content: 'hello', timestamp: 1000 };
    task.appendTranscript(entry);
    expect(task.getTranscript()).toHaveLength(1);
    expect(task.getTranscript()[0]).toEqual(entry);
  });

  it('appendTranscript preserves order', () => {
    const task = makeTask();
    task.appendTranscript({ role: 'user', content: 'msg1', timestamp: 1 });
    task.appendTranscript({ role: 'assistant', content: 'msg2', timestamp: 2 });
    const transcript = task.getTranscript();
    expect(transcript[0].content).toBe('msg1');
    expect(transcript[1].content).toBe('msg2');
  });

  it('getTranscript returns readonly array (external mutation does not affect internal)', () => {
    const task = makeTask();
    task.appendTranscript({ role: 'user', content: 'original', timestamp: 1 });
    const transcript = task.getTranscript() as TranscriptEntry[];
    // Attempt to mutate the returned array
    transcript.push({ role: 'attacker', content: 'injected', timestamp: 2 });
    // Internal state should still have only 1 entry
    expect(task.getTranscript()).toHaveLength(1);
  });

  it('appendTranscript supports optional toolCallId', () => {
    const task = makeTask();
    const entry: TranscriptEntry = {
      role: 'tool',
      content: 'result',
      timestamp: 5,
      toolCallId: 'call-abc',
    };
    task.appendTranscript(entry);
    expect(task.getTranscript()[0].toolCallId).toBe('call-abc');
  });
});

// --------------------------------------------------------------------------
// Pending messages
// --------------------------------------------------------------------------

describe('AgentTask pending messages', () => {
  it('starts with zero pending messages', () => {
    const task = makeTask();
    expect(task.getPendingMessageCount()).toBe(0);
  });

  it('enqueuePendingMessage increases count', () => {
    const task = makeTask();
    task.enqueuePendingMessage({ role: 'user', content: 'hi' });
    expect(task.getPendingMessageCount()).toBe(1);
  });

  it('drainPendingMessages returns all messages', () => {
    const task = makeTask();
    task.enqueuePendingMessage({ role: 'user', content: 'msg1' });
    task.enqueuePendingMessage({ role: 'user', content: 'msg2' });
    const drained = task.drainPendingMessages();
    expect(drained).toHaveLength(2);
    expect(drained[0].content).toBe('msg1');
    expect(drained[1].content).toBe('msg2');
  });

  it('drain empties the queue', () => {
    const task = makeTask();
    task.enqueuePendingMessage({ role: 'user', content: 'hi' });
    task.drainPendingMessages();
    expect(task.getPendingMessageCount()).toBe(0);
    expect(task.drainPendingMessages()).toHaveLength(0);
  });

  it('drain returns copy (mutation does not affect queue)', () => {
    const task = makeTask();
    task.enqueuePendingMessage({ role: 'user', content: 'original' });
    const first = task.drainPendingMessages();
    // push onto the drained copy
    first.push({ role: 'hacker', content: 'injected' });
    // next drain should be empty
    expect(task.drainPendingMessages()).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------------

describe('AgentTask persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-task-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loadFromDisk returns null for nonexistent agent', async () => {
    const result = await AgentTask.loadFromDisk(tempDir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('saveToDisk + loadFromDisk round-trip preserves id and status', async () => {
    const task = makeTask('agent-42');
    task.register();
    task.start();
    task.stop();
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-42');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('agent-42');
    expect(loaded!.status).toBe('stopped');
  });

  it('round-trip preserves sidecar metadata', async () => {
    const meta = makeMetadata({ agentType: 'reviewer', model: 'deepseek-chat' });
    const task = new AgentTask('agent-meta', meta);
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-meta');
    expect(loaded!.sidecarMetadata.agentType).toBe('reviewer');
    expect(loaded!.sidecarMetadata.model).toBe('deepseek-chat');
    expect(loaded!.agentType).toBe('reviewer');
  });

  it('round-trip preserves error field', async () => {
    const task = makeTask('agent-err');
    task.register();
    task.start();
    task.fail('disk full');
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-err');
    expect(loaded!.status).toBe('failed');
    expect(loaded!.error).toBe('disk full');
  });

  it('round-trip preserves pending messages', async () => {
    const task = makeTask('agent-msgs');
    task.enqueuePendingMessage({ role: 'user', content: 'pending msg' });
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-msgs');
    expect(loaded!.getPendingMessageCount()).toBe(1);
    const msgs = loaded!.drainPendingMessages();
    expect(msgs[0].content).toBe('pending msg');
  });

  it('round-trip preserves transcript (JSONL)', async () => {
    const task = makeTask('agent-transcript');
    task.appendTranscript({ role: 'user', content: 'hello', timestamp: 100 });
    task.appendTranscript({ role: 'assistant', content: 'world', timestamp: 200, toolCallId: 'c1' });
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-transcript');
    const transcript = loaded!.getTranscript();
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toEqual({ role: 'user', content: 'hello', timestamp: 100 });
    expect(transcript[1].toolCallId).toBe('c1');
  });

  it('round-trip with empty transcript writes and loads cleanly', async () => {
    const task = makeTask('agent-empty');
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-empty');
    expect(loaded!.getTranscript()).toHaveLength(0);
  });

  it('saveToDisk is idempotent (second save overwrites first)', async () => {
    const task = makeTask('agent-idem');
    task.appendTranscript({ role: 'user', content: 'first', timestamp: 1 });
    await task.saveToDisk(tempDir);

    task.appendTranscript({ role: 'user', content: 'second', timestamp: 2 });
    await task.saveToDisk(tempDir);

    const loaded = await AgentTask.loadFromDisk(tempDir, 'agent-idem');
    expect(loaded!.getTranscript()).toHaveLength(2);
  });
});
