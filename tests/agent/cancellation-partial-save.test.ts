// ============================================================================
// AgentTask.saveToDisk + loadFromDisk round-trip (AC-B partial save)
// ============================================================================
//
// Covers the partial-flush contract that Phase 3 wired into
// subagentExecutor's abort path. AC-B requires cancelled subagents to
// leave behind a readable transcript.jsonl + metadata.json under
// <sessionDir>/agents/<agentId>/.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentTask } from '../../src/main/agent/agentTask';

describe('AgentTask.saveToDisk — AC-B partial save', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'cancel-partial-'));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('persists transcript.jsonl + metadata.json with status=cancelled', async () => {
    const task = new AgentTask('agent-1', {
      agentType: 'dynamic',
      parentSessionId: 'sess-test',
      spawnTime: Date.now(),
      model: 'test',
      toolPool: [],
    });
    task.register();
    task.start();
    task.appendTranscript({
      role: 'user',
      content: 'first prompt',
      timestamp: Date.now(),
    });
    task.appendTranscript({
      role: 'assistant',
      content: 'partial output before cancel',
      timestamp: Date.now(),
    });
    task.fail('cancelled (parent-cancel)');

    await task.saveToDisk(sessionDir);

    const agentDir = join(sessionDir, 'agents', 'agent-1');
    expect(existsSync(join(agentDir, 'transcript.jsonl'))).toBe(true);
    expect(existsSync(join(agentDir, 'metadata.json'))).toBe(true);

    const transcript = readFileSync(join(agentDir, 'transcript.jsonl'), 'utf-8');
    const lines = transcript.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).role).toBe('user');
    expect(JSON.parse(lines[1]).content).toContain('partial output');

    const metadata = JSON.parse(readFileSync(join(agentDir, 'metadata.json'), 'utf-8'));
    expect(metadata.id).toBe('agent-1');
    expect(metadata.status).toBe('failed');
    expect(metadata.error).toContain('parent-cancel');
  });

  it('loadFromDisk round-trips the saved state', async () => {
    const task = new AgentTask('agent-2', {
      agentType: 'dynamic',
      parentSessionId: 'sess-rt',
      spawnTime: Date.now(),
      model: 'test',
      toolPool: [],
    });
    task.register();
    task.start();
    task.appendTranscript({
      role: 'assistant',
      content: 'iteration 1 output',
      timestamp: Date.now(),
    });
    task.fail('cancelled (user-cancel)');
    await task.saveToDisk(sessionDir);

    const reloaded = await AgentTask.loadFromDisk(sessionDir, 'agent-2');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe('agent-2');
  });

  it('siblings under same sessionDir do not collide', async () => {
    for (const id of ['a-1', 'a-2', 'a-3']) {
      const t = new AgentTask(id, {
        agentType: 'dynamic',
        parentSessionId: 's',
        spawnTime: Date.now(),
        model: 'test',
        toolPool: [],
      });
      t.register();
      t.start();
      t.appendTranscript({ role: 'assistant', content: `from ${id}`, timestamp: 0 });
      t.fail('cancelled');
      await t.saveToDisk(sessionDir);
    }

    for (const id of ['a-1', 'a-2', 'a-3']) {
      const agentDir = join(sessionDir, 'agents', id);
      const transcript = readFileSync(join(agentDir, 'transcript.jsonl'), 'utf-8');
      expect(transcript).toContain(`from ${id}`);
    }
  });
});
