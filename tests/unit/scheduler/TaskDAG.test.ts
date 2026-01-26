// ============================================================================
// TaskDAG Tests
// Tests for DAG construction, validation, topological sorting, and state management
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskDAG } from '../../../src/main/scheduler/TaskDAG';
import type {
  DAGTask,
  TaskStatus,
  AgentTaskConfig,
  DAGEvent,
} from '../../../src/shared/types/taskDAG';

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TaskDAG', () => {
  let dag: TaskDAG;

  beforeEach(() => {
    dag = new TaskDAG('test-dag', 'Test DAG');
  });

  // --------------------------------------------------------------------------
  // Basic Construction
  // --------------------------------------------------------------------------
  describe('Basic Construction', () => {
    it('should create empty DAG', () => {
      expect(dag.getId()).toBe('test-dag');
      expect(dag.getName()).toBe('Test DAG');
      expect(dag.getAllTasks().length).toBe(0);
      expect(dag.getStatus()).toBe('idle');
    });

    it('should allow custom options', () => {
      const customDag = new TaskDAG('custom', 'Custom DAG', {
        maxParallelism: 8,
        defaultTimeout: 60000,
        failureStrategy: 'continue',
      });

      const options = customDag.getOptions();
      expect(options.maxParallelism).toBe(8);
      expect(options.defaultTimeout).toBe(60000);
      expect(options.failureStrategy).toBe('continue');
    });
  });

  // --------------------------------------------------------------------------
  // Task Addition
  // --------------------------------------------------------------------------
  describe('Task Addition', () => {
    it('should add agent task', () => {
      dag.addAgentTask('task1', {
        role: 'coder',
        prompt: 'Write code',
      });

      const task = dag.getTask('task1');
      expect(task).toBeDefined();
      expect(task?.type).toBe('agent');
      expect(task?.status).toBe('pending');
      expect((task?.config as AgentTaskConfig).role).toBe('coder');
    });

    it('should add shell task', () => {
      dag.addShellTask('build', {
        command: 'npm run build',
        cwd: '/project',
      });

      const task = dag.getTask('build');
      expect(task).toBeDefined();
      expect(task?.type).toBe('shell');
    });

    it('should add checkpoint task', () => {
      dag.addAgentTask('task1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('task2', { role: 'tester', prompt: 'Test' });
      dag.addCheckpoint('sync', ['task1', 'task2']);

      const checkpoint = dag.getTask('sync');
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.type).toBe('checkpoint');
      expect(checkpoint?.dependencies).toEqual(['task1', 'task2']);
    });

    it('should throw on duplicate task id', () => {
      dag.addAgentTask('task1', { role: 'coder', prompt: 'Write' });

      expect(() => {
        dag.addAgentTask('task1', { role: 'tester', prompt: 'Test' });
      }).toThrow('Task "task1" already exists');
    });

    it('should throw on non-existent dependency during add', () => {
      expect(() => {
        dag.addAgentTask('task1', { role: 'coder', prompt: 'Write' }, {
          dependencies: ['non-existent'],
        });
      }).toThrow('Dependency "non-existent" not found');
    });

    it('should support fluent API', () => {
      const result = dag
        .addAgentTask('t1', { role: 'coder', prompt: 'Write' })
        .addAgentTask('t2', { role: 'tester', prompt: 'Test' })
        .addDependency('t2', 't1');

      expect(result).toBe(dag);
      expect(dag.getAllTasks().length).toBe(2);
    });

    it('should update dependents when adding dependencies', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'Test' });
      dag.addDependency('t2', 't1');

      const t1 = dag.getTask('t1');
      const t2 = dag.getTask('t2');

      expect(t1?.dependents).toContain('t2');
      expect(t2?.dependencies).toContain('t1');
    });
  });

  // --------------------------------------------------------------------------
  // Task Removal
  // --------------------------------------------------------------------------
  describe('Task Removal', () => {
    it('should remove task and update dependencies', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'reviewer', prompt: 'Review' }, { dependencies: ['t1'] });
      dag.addAgentTask('t3', { role: 'tester', prompt: 'Test' }, { dependencies: ['t2'] });

      dag.removeTask('t2');

      expect(dag.getTask('t2')).toBeUndefined();
      // t3 should no longer depend on t2
      expect(dag.getTask('t3')?.dependencies).not.toContain('t2');
      // t1 should no longer have t2 as dependent
      expect(dag.getTask('t1')?.dependents).not.toContain('t2');
    });

    it('should handle removing non-existent task', () => {
      dag.removeTask('non-existent');
      expect(dag.getAllTasks().length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Status Management
  // --------------------------------------------------------------------------
  describe('Status Management', () => {
    it('should update task status', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });

      // Simulate execution flow
      dag.updateTaskStatus('t1', 'ready');
      expect(dag.getTask('t1')?.status).toBe('ready');

      dag.updateTaskStatus('t1', 'running');
      expect(dag.getTask('t1')?.status).toBe('running');
      expect(dag.getTask('t1')?.metadata.startedAt).toBeDefined();

      dag.updateTaskStatus('t1', 'completed', {
        output: { text: 'Done', iterations: 3 },
      });
      expect(dag.getTask('t1')?.status).toBe('completed');
      expect(dag.getTask('t1')?.metadata.completedAt).toBeDefined();
      expect(dag.getTask('t1')?.metadata.duration).toBeDefined();
      expect(dag.getTask('t1')?.output?.text).toBe('Done');
    });

    it('should throw on updating non-existent task', () => {
      expect(() => {
        dag.updateTaskStatus('non-existent', 'running');
      }).toThrow('Task "non-existent" not found');
    });

    it('should update dependent statuses when task completes', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'Test' }, { dependencies: ['t1'] });

      // Initially t2 is pending
      expect(dag.getTask('t2')?.status).toBe('pending');

      // Complete t1
      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'completed', { output: { text: 'Done' } });

      // t2 should now be ready
      expect(dag.getTask('t2')?.status).toBe('ready');
    });

    it('should handle task failure', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'failed', {
        failure: { message: 'Error', retryable: false },
      });

      expect(dag.getTask('t1')?.status).toBe('failed');
      expect(dag.getTask('t1')?.failure?.message).toBe('Error');
    });
  });

  // --------------------------------------------------------------------------
  // Ready Tasks Detection
  // --------------------------------------------------------------------------
  describe('Ready Tasks Detection', () => {
    it('should detect tasks with no dependencies as ready', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'Test' });

      const ready = dag.getReadyTasks();
      expect(ready.length).toBe(2);
      expect(ready.map(t => t.id)).toContain('t1');
      expect(ready.map(t => t.id)).toContain('t2');
    });

    it('should not include tasks with unmet dependencies', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'Test' }, { dependencies: ['t1'] });

      const ready = dag.getReadyTasks();
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('t1');
    });

    it('should respect priority in ready tasks order', () => {
      dag.addAgentTask('low', { role: 'coder', prompt: 'Low' }, { priority: 'low' });
      dag.addAgentTask('high', { role: 'coder', prompt: 'High' }, { priority: 'high' });
      dag.addAgentTask('normal', { role: 'coder', prompt: 'Normal' }, { priority: 'normal' });
      dag.addAgentTask('critical', { role: 'coder', prompt: 'Critical' }, { priority: 'critical' });

      const ready = dag.getReadyTasks();
      expect(ready[0].id).toBe('critical');
      expect(ready[1].id).toBe('high');
      expect(ready[2].id).toBe('normal');
      expect(ready[3].id).toBe('low');
    });
  });

  // --------------------------------------------------------------------------
  // Topological Sorting
  // --------------------------------------------------------------------------
  describe('Topological Sorting', () => {
    it('should return topological order', () => {
      dag.addAgentTask('a', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('b', { role: 'coder', prompt: 'B' }, { dependencies: ['a'] });
      dag.addAgentTask('c', { role: 'coder', prompt: 'C' }, { dependencies: ['a'] });
      dag.addAgentTask('d', { role: 'coder', prompt: 'D' }, { dependencies: ['b', 'c'] });

      const order = dag.getTopologicalOrder();

      // 'a' must come before 'b' and 'c'
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
      // 'b' and 'c' must come before 'd'
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
    });

    it('should detect circular dependency', () => {
      // Create circular dependency manually
      dag.addAgentTask('a', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('b', { role: 'coder', prompt: 'B' }, { dependencies: ['a'] });

      // Get internal task and manually add circular dep
      const taskA = dag.getTask('a')!;
      taskA.dependencies.push('b');
      const taskB = dag.getTask('b')!;
      taskB.dependents.push('a');

      expect(() => {
        dag.getTopologicalOrder();
      }).toThrow('Circular dependency');
    });

    it('should cache topological order', () => {
      dag.addAgentTask('a', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('b', { role: 'coder', prompt: 'B' }, { dependencies: ['a'] });

      const order1 = dag.getTopologicalOrder();
      const order2 = dag.getTopologicalOrder();

      // Should return same reference (cached)
      expect(order1).toBe(order2);
    });

    it('should invalidate cache on task addition', () => {
      dag.addAgentTask('a', { role: 'coder', prompt: 'A' });
      const order1 = dag.getTopologicalOrder();

      dag.addAgentTask('b', { role: 'coder', prompt: 'B' });
      const order2 = dag.getTopologicalOrder();

      // Should be different reference (cache invalidated)
      expect(order1).not.toBe(order2);
    });
  });

  // --------------------------------------------------------------------------
  // Execution Levels
  // --------------------------------------------------------------------------
  describe('Execution Levels', () => {
    it('should group tasks by execution level', () => {
      dag.addAgentTask('a', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('b', { role: 'coder', prompt: 'B' });
      dag.addAgentTask('c', { role: 'coder', prompt: 'C' }, { dependencies: ['a', 'b'] });
      dag.addAgentTask('d', { role: 'coder', prompt: 'D' }, { dependencies: ['c'] });

      const levels = dag.getExecutionLevels();

      expect(levels.length).toBe(3);
      // Level 0: a, b (no deps)
      expect(levels[0]).toContain('a');
      expect(levels[0]).toContain('b');
      // Level 1: c (depends on a, b)
      expect(levels[1]).toContain('c');
      // Level 2: d (depends on c)
      expect(levels[2]).toContain('d');
    });
  });

  // --------------------------------------------------------------------------
  // Critical Path
  // --------------------------------------------------------------------------
  describe('Critical Path', () => {
    it('should calculate critical path', () => {
      dag.addAgentTask('a', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('b', { role: 'coder', prompt: 'B' }, { dependencies: ['a'] });
      dag.addAgentTask('c', { role: 'coder', prompt: 'C' });
      dag.addAgentTask('d', { role: 'coder', prompt: 'D' }, { dependencies: ['b', 'c'] });

      const criticalPath = dag.getCriticalPath();

      // Critical path should be a -> b -> d (longest path)
      expect(criticalPath).toContain('a');
      expect(criticalPath).toContain('b');
      expect(criticalPath).toContain('d');
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------
  describe('Validation', () => {
    it('should reject empty DAG', () => {
      const result = dag.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('DAG is empty');
    });

    it('should pass validation for valid DAG', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'Test' }, { dependencies: ['t1'] });

      const result = dag.validate();
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should warn about isolated tasks', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'Write' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'Test' }); // Isolated

      const result = dag.validate();
      // Both are isolated when there are multiple tasks with no connections
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should detect missing role in agent task', () => {
      // Add a malformed task directly
      const task: DAGTask = {
        id: 'bad-task',
        name: 'Bad Task',
        type: 'agent',
        status: 'pending',
        priority: 'normal',
        metadata: { createdAt: Date.now(), retryCount: 0, maxRetries: 0 },
        dependencies: [],
        dependents: [],
        config: { type: 'agent', role: '', prompt: 'test' } as AgentTaskConfig,
      };
      (dag as unknown as { tasks: Map<string, DAGTask> }).tasks.set('bad-task', task);

      const result = dag.validate();
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('missing role'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------
  describe('Statistics', () => {
    it('should calculate statistics', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' });
      dag.addAgentTask('t3', { role: 'reviewer', prompt: 'C' }, { dependencies: ['t1', 't2'] });

      const stats = dag.getStatistics();

      expect(stats.totalTasks).toBe(3);
      expect(stats.pendingTasks).toBe(3);
      expect(stats.completedTasks).toBe(0);
      expect(stats.maxParallelism).toBe(2); // t1 and t2 can run in parallel
    });

    it('should update statistics as tasks complete', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' }, { dependencies: ['t1'] });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'completed', { output: { text: 'Done' } });

      const stats = dag.getStatistics();
      expect(stats.completedTasks).toBe(1);
      expect(stats.readyTasks).toBe(1); // t2 is now ready
    });
  });

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------
  describe('Events', () => {
    it('should emit task events', () => {
      const events: DAGEvent[] = [];
      dag.on('task:ready', (e) => events.push(e));
      dag.on('task:start', (e) => events.push(e));
      dag.on('task:complete', (e) => events.push(e));

      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'completed', { output: { text: 'Done' } });

      expect(events.length).toBe(3);
      expect(events.map(e => e.type)).toEqual(['task:ready', 'task:start', 'task:complete']);
    });

    it('should emit DAG events', () => {
      const events: DAGEvent[] = [];
      dag.on('dag:start', (e) => events.push(e));
      dag.on('dag:complete', (e) => events.push(e));

      dag.setStatus('running');
      dag.setStatus('completed');

      expect(events.length).toBe(2);
      expect(events.map(e => e.type)).toEqual(['dag:start', 'dag:complete']);
    });
  });

  // --------------------------------------------------------------------------
  // Serialization
  // --------------------------------------------------------------------------
  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' }, { dependencies: ['t1'] });

      const json = dag.toJSON();

      expect(json.id).toBe('test-dag');
      expect(json.name).toBe('Test DAG');
      expect(json.tasks.length).toBe(2);
    });

    it('should deserialize from JSON', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' }, { dependencies: ['t1'] });

      const json = dag.toJSON();
      const restored = TaskDAG.fromJSON(json);

      expect(restored.getId()).toBe('test-dag');
      expect(restored.getAllTasks().length).toBe(2);
      expect(restored.getTask('t2')?.dependencies).toContain('t1');
      expect(restored.getTask('t1')?.dependents).toContain('t2');
    });
  });

  // --------------------------------------------------------------------------
  // Reset
  // --------------------------------------------------------------------------
  describe('Reset', () => {
    it('should reset DAG state', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'completed', { output: { text: 'Done' } });
      dag.setStatus('completed');
      dag.setSharedData('key', 'value');

      dag.reset();

      expect(dag.getStatus()).toBe('idle');
      expect(dag.getTask('t1')?.status).toBe('pending');
      expect(dag.getTask('t1')?.output).toBeUndefined();
      expect(dag.getSharedData('key')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Shared Context
  // --------------------------------------------------------------------------
  describe('Shared Context', () => {
    it('should store and retrieve shared data', () => {
      dag.setSharedData('findings', { issue: 'bug' });
      dag.setSharedData('files', ['a.ts', 'b.ts']);

      expect(dag.getSharedData('findings')).toEqual({ issue: 'bug' });
      expect(dag.getSharedData('files')).toEqual(['a.ts', 'b.ts']);
    });

    it('should return all shared data', () => {
      dag.setSharedData('key1', 'value1');
      dag.setSharedData('key2', 'value2');

      const all = dag.getAllSharedData();
      expect(all.size).toBe(2);
      expect(all.get('key1')).toBe('value1');
    });
  });

  // --------------------------------------------------------------------------
  // Failure Handling
  // --------------------------------------------------------------------------
  describe('Failure Handling', () => {
    it('should skip dependents on failure with continue strategy', () => {
      dag.updateOptions({ failureStrategy: 'continue' });
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' }, { dependencies: ['t1'] });
      dag.addAgentTask('t3', { role: 'reviewer', prompt: 'C' }, { dependencies: ['t2'] });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'failed', {
        failure: { message: 'Error', retryable: false },
      });

      expect(dag.getTask('t2')?.status).toBe('skipped');
      expect(dag.getTask('t3')?.status).toBe('skipped');
    });

    it('should cancel all on failure with fail-fast strategy', () => {
      dag.updateOptions({ failureStrategy: 'fail-fast' });
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'failed', {
        failure: { message: 'Error', retryable: false },
      });

      expect(dag.getStatus()).toBe('failed');
    });

    it('should allow failure if allowFailure is set', () => {
      dag.updateOptions({ failureStrategy: 'fail-fast' });
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' }, { allowFailure: true });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' }, { dependencies: ['t1'] });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'failed', {
        failure: { message: 'Error', retryable: false },
      });

      // t2 should still become ready because t1 has allowFailure
      expect(dag.getTask('t2')?.status).toBe('ready');
      expect(dag.getStatus()).not.toBe('failed');
    });
  });

  // --------------------------------------------------------------------------
  // Task Retry
  // --------------------------------------------------------------------------
  describe('Task Retry', () => {
    it('should retry task if retryable', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      const task = dag.getTask('t1')!;
      task.metadata.maxRetries = 2;

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');

      dag.failTask('t1', { message: 'Temporary error', retryable: true });

      expect(dag.getTask('t1')?.status).toBe('ready'); // Reset to ready for retry
      expect(dag.getTask('t1')?.metadata.retryCount).toBe(1);
    });

    it('should fail after max retries', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      const task = dag.getTask('t1')!;
      task.metadata.maxRetries = 1;
      task.metadata.retryCount = 1; // Already retried once

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');

      dag.failTask('t1', { message: 'Persistent error', retryable: true });

      expect(dag.getTask('t1')?.status).toBe('failed'); // No more retries
    });
  });

  // --------------------------------------------------------------------------
  // Completion Checks
  // --------------------------------------------------------------------------
  describe('Completion Checks', () => {
    it('should detect DAG completion', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });
      dag.addAgentTask('t2', { role: 'tester', prompt: 'B' });

      expect(dag.isComplete()).toBe(false);

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'completed', { output: { text: 'Done' } });

      expect(dag.isComplete()).toBe(false);

      dag.updateTaskStatus('t2', 'ready');
      dag.updateTaskStatus('t2', 'running');
      dag.updateTaskStatus('t2', 'completed', { output: { text: 'Done' } });

      expect(dag.isComplete()).toBe(true);
    });

    it('should detect successful completion', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'completed', { output: { text: 'Done' } });

      expect(dag.isSuccessful()).toBe(true);
    });

    it('should detect failure', () => {
      dag.addAgentTask('t1', { role: 'coder', prompt: 'A' });

      dag.updateTaskStatus('t1', 'ready');
      dag.updateTaskStatus('t1', 'running');
      dag.updateTaskStatus('t1', 'failed', {
        failure: { message: 'Error', retryable: false },
      });

      expect(dag.isSuccessful()).toBe(false);
    });
  });
});
