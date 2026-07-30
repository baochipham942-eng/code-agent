import { beforeEach, describe, expect, it } from 'vitest';

import { taskDeduplication } from '../../../src/host/agent/taskDeduplication';
import { getSwarmRunScopeKey, type SwarmRunScope } from '../../../src/shared/contract/swarm';

const SCOPE_A: SwarmRunScope = {
  sessionId: 'shared-session',
  runId: 'run-a',
  treeId: 'shared-tree',
};
const SCOPE_B: SwarmRunScope = {
  sessionId: 'shared-session',
  runId: 'run-b',
  treeId: 'shared-tree',
};

describe('taskDeduplication Team scope', () => {
  beforeEach(() => taskDeduplication.clear());

  it('allows two same-role Teams to run the same prompt without sharing in-flight state or result', () => {
    const namespaceA = getSwarmRunScopeKey(SCOPE_A);
    const namespaceB = getSwarmRunScopeKey(SCOPE_B);
    const prompt = 'review the same file';

    const hashA = taskDeduplication.registerTask('reviewer', prompt, namespaceA);
    expect(taskDeduplication.isDuplicate('reviewer', prompt, namespaceA)).toMatchObject({
      isDuplicate: true,
      reason: expect.stringContaining('正在执行'),
    });
    expect(taskDeduplication.isDuplicate('reviewer', prompt, namespaceB)).toEqual({
      isDuplicate: false,
    });

    const hashB = taskDeduplication.registerTask('reviewer', prompt, namespaceB);
    expect(hashB).not.toBe(hashA);
    taskDeduplication.completeTask(hashA, 'result-a');
    taskDeduplication.completeTask(hashB, 'result-b');

    expect(taskDeduplication.isDuplicate('reviewer', prompt, namespaceA)).toMatchObject({
      isDuplicate: true,
      cachedResult: 'result-a',
    });
    expect(taskDeduplication.isDuplicate('reviewer', prompt, namespaceB)).toMatchObject({
      isDuplicate: true,
      cachedResult: 'result-b',
    });
  });

  it('rejects a second registration for the same logical running task', () => {
    const namespace = getSwarmRunScopeKey(SCOPE_A);
    taskDeduplication.registerTask('reviewer', 'same task', namespace);

    expect(() => taskDeduplication.registerTask('reviewer', 'same task', namespace))
      .toThrow('LOGICAL_RUN_STILL_RUNNING');
  });

  it('rejects re-registering a successfully completed logical task', () => {
    const namespace = getSwarmRunScopeKey(SCOPE_A);
    const hash = taskDeduplication.registerTask('reviewer', 'same task', namespace);
    taskDeduplication.completeTask(hash, 'done');

    expect(() => taskDeduplication.registerTask('reviewer', 'same task', namespace))
      .toThrow('LOGICAL_RUN_ALREADY_COMPLETED');
  });

  it('keeps completed immutable when a late failure arrives', () => {
    const namespace = getSwarmRunScopeKey(SCOPE_A);
    const hash = taskDeduplication.registerTask('reviewer', 'same task', namespace);
    taskDeduplication.completeTask(hash, 'durable result');

    taskDeduplication.failTask(hash);

    expect(taskDeduplication.isDuplicate('reviewer', 'same task', namespace)).toMatchObject({
      isDuplicate: true,
      cachedResult: 'durable result',
    });
  });
});
