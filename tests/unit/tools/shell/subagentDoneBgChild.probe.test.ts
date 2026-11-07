// Hermetic pin for N-BGTASK-AGENT-DONE-CHILD-REAP-PROBE (covers tests/manual/subagentBgReapProbe.manual.ts).
// Premise: nothing reaps a background shell when the agent that started it finishes, and the ledger row
// carries no owner-agent field. Evidence class: real-runtime for the ledger/process, static-contract for the probe.
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAllBackgroundTasks,
  killBackgroundTask,
  startBackgroundTask,
} from '../../../../src/host/tools/shell/backgroundTasks';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const taskIds: string[] = [];

posixOnly('subagent-done background child probe', () => {
  afterEach(async () => {
    for (const id of taskIds.splice(0)) await killBackgroundTask(id);
  });

  it('keeps the child alive and records the owning sub-agent without assigning primary', async () => {
    const started = startBackgroundTask('sleep 7313', tmpdir(), 60_000, {
      sessionId: 'parent-session',
      toolCallId: 'call_1',
      ownerAgentId: 'probe-agent',
    });
    expect(started.success).toBe(true);
    taskIds.push(started.taskId!);
    // The "agent completion" step has no reaping hook; simply let time pass as the probe does.
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const row = getAllBackgroundTasks().find((task) => task.taskId === started.taskId)!;
    expect(row.status).toBe('running');
    expect(row.sessionId).toBe('parent-session');
    expect(row.toolCallId).toBe('call_1');
    expect(row.ownerAgentId).toBe('probe-agent');

    const primary = startBackgroundTask('sleep 7314', tmpdir(), 60_000, {
      sessionId: 'parent-session',
      ownerAgentId: 'primary',
    });
    expect(primary.success).toBe(true);
    taskIds.push(primary.taskId!);
    expect(getAllBackgroundTasks().find((task) => task.taskId === primary.taskId))
      .not.toHaveProperty('ownerAgentId');
  });

  it('probe script asserts the premise and exits non-zero when it does not hold', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../manual/subagentBgReapProbe.manual.ts'), 'utf8');
    expect(source).toContain("t.status === 'running'");
    expect(source).toContain('process.exit(1)');
    expect(source).toContain('sleep 7311');
  });
});
