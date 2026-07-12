import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('GraphEvent compatibility wiring', () => {
  it('routes Auto Agent Graph events through the shared compatibility sink', () => {
    const runner = read('src/host/agent/orchestrator/autoAgentRunner.ts');
    const coordinator = read('src/host/agent/autoAgentCoordinator.ts');
    expect(runner).toContain('new GraphEventCompatibilityAdapter');
    expect(runner).toContain('compatibilitySink: compatibility');
    expect(runner).toContain('await compatibility.flushTerminals()');
    expect(coordinator).toContain('emit: (event) => compatibility.emit(event)');
  });

  it('routes Agent Team Graph events and its legacy facade through the same sink', () => {
    const facade = read('src/host/agent/multiagentTools/spawnAgent.ts');
    const coordinator = read('src/host/agent/parallelAgentCoordinator.ts');
    expect(facade).toContain('new GraphEventCompatibilityAdapter');
    expect(facade).toMatch(/executeParallel\(tasks, compatibility\)/);
    expect(facade).toContain('await compatibility.flushTerminals()');
    expect(coordinator).toContain('emit: (event) => compatibilitySink.emit(event)');
    expect(coordinator).not.toContain("this.emit('task:start', { taskId: task.id, role: task.role });\n      // Inject shared context");
  });
});
