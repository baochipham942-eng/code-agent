import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  classifyToolCalls,
  executeOrderedSegments,
} from '../../../src/host/agent/toolExecution/parallelStrategy';
import { MAX_PARALLEL_TOOLS } from '../../../src/host/agent/loopTypes';
import type { MCPToolAnnotations } from '../../../src/host/mcp/types';
import {
  segmentAccessesConflict,
  toolResourceAccessesConflict,
} from '../../../src/host/security/resourceScope';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { resolveToolCallAccesses } from '../../../src/host/tools/dispatch/resolveToolCallAccess';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

const ROOT = '/tmp/toolres-k2';
const options = { workspace: ROOT, cwd: ROOT };

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

function isBarrier(toolCall: ToolCall): boolean {
  if (toolCall.name === 'PlanMode') return toolCall.arguments.action === 'exit';
  return new Set([
    'AskUserQuestion',
    'ask_user_question',
    'confirm_action',
    'exit_plan_mode',
    'attempt_completion',
  ]).has(toolCall.name);
}

function pairConflicts(
  left: ToolCall,
  right: ToolCall,
  annotations?: Map<string, MCPToolAnnotations>,
): boolean {
  const leftAccesses = resolveToolCallAccesses(left, { ...options, mcpAnnotations: annotations });
  const rightAccesses = resolveToolCallAccesses(right, { ...options, mcpAnnotations: annotations });
  return segmentAccessesConflict(leftAccesses, rightAccesses);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = [
  'read-a', 'read-b', 'write-a', 'write-b', 'bash', 'task',
  'task-update', 'task-list', 'plan-read',
  'mcp-read', 'mcp-plain', 'ask', 'confirm', 'exit-plan', 'plan-exit', 'plan-enter', 'complete',
] as const;

function callForKind(kind: (typeof KINDS)[number], index: number): ToolCall {
  const id = `c${index}`;
  switch (kind) {
    case 'read-a': return call(id, 'Read', { file_path: 'a.txt' });
    case 'read-b': return call(id, 'Read', { file_path: 'b.txt' });
    case 'write-a': return call(id, 'Write', { file_path: 'a.txt', content: 'x' });
    case 'write-b': return call(id, 'Write', { file_path: 'b.txt', content: 'y' });
    case 'bash': return call(id, 'Bash', { command: 'pwd' });
    case 'task': return call(id, 'Task', { subagent_type: 'coder', prompt: 'edit a.txt' });
    case 'task-update': return call(id, 'task_update', { task_id: 'T1', status: 'completed' });
    case 'task-list': return call(id, 'task_list', {});
    case 'plan-read': return call(id, 'plan_read', {});
    case 'mcp-read': return call(id, 'mcp_docs_read');
    case 'mcp-plain': return call(id, 'mcp_docs_write');
    case 'ask': return call(id, 'AskUserQuestion', { questions: [] });
    case 'confirm': return call(id, 'confirm_action');
    case 'exit-plan': return call(id, 'exit_plan_mode');
    case 'plan-exit': return call(id, 'PlanMode', { action: 'exit', plan: 'ship it' });
    case 'plan-enter': return call(id, 'PlanMode', { action: 'enter' });
    case 'complete': return call(id, 'attempt_completion', { result: 'done' });
    default: return call(id, 'Read', { file_path: 'a.txt' });
  }
}

describe('order-preserving segments', () => {
  it('a call runs concurrently only with earlier calls of its own segment; segments run in model order; results are returned by original index; nothing after a barrier executes.', async () => {
    getProtocolRegistry();
    const random = mulberry32(20260930);
    const annotations = new Map<string, MCPToolAnnotations>([
      ['mcp_docs_read', { readOnlyHint: true }],
    ]);

    for (let sequence = 0; sequence < 40; sequence += 1) {
      const length = 1 + Math.floor(random() * 6);
      const calls = Array.from({ length }, (_, index) => callForKind(
        KINDS[Math.floor(random() * KINDS.length)],
        index,
      ));
      const classified = classifyToolCalls(calls, annotations, options);
      const label = `sequence ${sequence}: ${calls.map((item) => item.name).join(',')}`;

      let previousMax = -1;
      for (const segment of classified.segments) {
        const indexes = segment.map((entry) => entry.index);
        expect(Math.min(...indexes), label).toBeGreaterThan(previousMax);
        expect(indexes, label).toEqual([...indexes].sort((left, right) => left - right));
        previousMax = Math.max(...indexes);
        for (let left = 0; left < segment.length; left += 1) {
          for (let right = left + 1; right < segment.length; right += 1) {
            expect(pairConflicts(segment[left].toolCall, segment[right].toolCall, annotations), label).toBe(false);
          }
        }
        if (segment.some((entry) => isBarrier(entry.toolCall))) {
          expect(segment, label).toHaveLength(1);
          expect(segment, label).toBe(classified.segments[classified.segments.length - 1]);
        }
      }
      for (let segmentIndex = 1; segmentIndex < classified.segments.length; segmentIndex += 1) {
        const opener = classified.segments[segmentIndex][0];
        const previous = classified.segments[segmentIndex - 1];
        const blocked = isBarrier(opener.toolCall) || previous.some((member) => pairConflicts(
          opener.toolCall,
          member.toolCall,
          annotations,
        ));
        expect(blocked, label).toBe(true);
      }

      const firstBarrier = calls.findIndex((toolCall) => isBarrier(toolCall));
      const partitioned = [
        ...classified.segments.flat().map((entry) => entry.index),
        ...classified.deferred.map((entry) => entry.index),
      ];
      expect(partitioned, label).toEqual(calls.map((_, index) => index));
      expect(classified.deferred.map((entry) => entry.index), label).toEqual(
        firstBarrier === -1 ? [] : calls.map((_, index) => index).filter((index) => index > firstBarrier),
      );

      const segmentOf = new Map<number, number>();
      classified.segments.forEach((segment, segmentIndex) => {
        for (const entry of segment) segmentOf.set(entry.index, segmentIndex);
      });
      let clock = 0;
      const inFlight: Array<{ index: number; segment: number }> = [];
      const stamps: Array<{ index: number; segment: number; start: number; end: number }> = [];
      const results = await executeOrderedSegments<ToolResult>(classified.segments, classified.deferred, {
        resultCount: calls.length,
        maxParallel: MAX_PARALLEL_TOOLS,
        shouldHalt: () => false,
        prepare: () => {},
        run: async (entry): Promise<ToolResult> => {
          const segment = segmentOf.get(entry.index);
          expect(segment, label).toBeTypeOf('number');
          clock += 1;
          const start = clock;
          for (const other of inFlight) {
            expect(other.index, label).toBeLessThan(entry.index);
            expect(other.segment, label).toBe(segment);
          }
          inFlight.push({ index: entry.index, segment: segment ?? -1 });
          await Promise.resolve();
          clock += 1;
          const end = clock;
          const at = inFlight.findIndex((item) => item.index === entry.index);
          inFlight.splice(at, 1);
          stamps.push({ index: entry.index, segment: segment ?? -1, start, end });
          return { toolCallId: entry.toolCall.id, success: true, output: 'ok' };
        },
        deferredResult: (entry): ToolResult => ({
          toolCallId: entry.toolCall.id,
          success: false,
          error: 'BATCH_TERMINATED: calls after a barrier are deferred',
          metadata: { skipped: true, blocked: true, deferred: true, code: 'BATCH_TERMINATED' },
        }),
      });

      expect(results, label).toHaveLength(calls.length);
      for (let index = 0; index < calls.length; index += 1) {
        expect(results[index]?.toolCallId, label).toBe(calls[index].id);
        const ran = stamps.some((stamp) => stamp.index === index);
        if (firstBarrier !== -1 && index > firstBarrier) {
          expect(ran, label).toBe(false);
          expect(results[index]?.error, label).toMatch(/^BATCH_TERMINATED/);
          expect(results[index]?.metadata, label).toMatchObject({
            skipped: true,
            deferred: true,
            code: 'BATCH_TERMINATED',
          });
        } else {
          expect(ran, label).toBe(true);
        }
      }
      for (const left of stamps) {
        for (const right of stamps) {
          if (left.index >= right.index) continue;
          const overlaps = left.start < right.end && right.start < left.end;
          if (overlaps) expect(left.segment, label).toBe(right.segment);
        }
      }
      const ranges = new Map<number, { start: number; end: number }>();
      for (const stamp of stamps) {
        const range = ranges.get(stamp.segment) ?? { start: stamp.start, end: stamp.end };
        range.start = Math.min(range.start, stamp.start);
        range.end = Math.max(range.end, stamp.end);
        ranges.set(stamp.segment, range);
      }
      const orderedRanges = [...ranges.entries()].sort((left, right) => left[0] - right[0]);
      for (let index = 1; index < orderedRanges.length; index += 1) {
        expect(orderedRanges[index - 1][1].end, label).toBeLessThan(orderedRanges[index][1].start);
      }
    }
  });

  it('resolves registered Read and Write calls onto path domains', () => {
    getProtocolRegistry();
    const read = resolveToolCallAccesses(call('1', 'Read', { file_path: 'a.txt' }), options);
    const write = resolveToolCallAccesses(call('2', 'Write', { file_path: 'a.txt', content: 'x' }), options);
    expect(read[0]?.domain.type).toBe('path');
    expect(write[0]?.domain.type).toBe('path');
    expect(toolResourceAccessesConflict(read[0], write[0])).toBe(true);
    const classified = classifyToolCalls([
      call('2', 'Write', { file_path: 'a.txt', content: 'x' }),
      call('1', 'Read', { file_path: 'a.txt' }),
    ], undefined, options);
    expect(classified.segments.map((segment) => segment.map((entry) => entry.toolCall.name))).toEqual([
      ['Write'],
      ['Read'],
    ]);
  });

  it('keeps two pathless Grep calls in one segment and splits a cwd read from a write underneath it', () => {
    expect(classifyToolCalls([
      call('1', 'Grep', { pattern: 'alpha' }),
      call('2', 'Grep', { pattern: 'beta' }),
    ], undefined, options).segments).toHaveLength(1);
    expect(classifyToolCalls([
      call('1', 'Grep', { pattern: 'alpha' }),
      call('2', 'Write', { file_path: 'a.txt', content: 'x' }),
    ], undefined, options).segments.map((segment) => segment.map((entry) => entry.toolCall.name))).toEqual([
      ['Grep'],
      ['Write'],
    ]);
  });

  it.each([
    ['AskUserQuestion', { questions: [] }],
    ['ask_user_question', { questions: [] }],
    ['confirm_action', {}],
    ['exit_plan_mode', {}],
    ['attempt_completion', { result: 'done' }],
    ['PlanMode', { action: 'exit', plan: 'ship it' }],
  ] as const)('defers the write after %s', (name, args) => {
    const classified = classifyToolCalls([
      call('barrier', name, { ...args }),
      call('write', 'Write', { file_path: 'a.txt', content: 'x' }),
    ], undefined, options);
    expect(classified.segments.map((segment) => segment.map((entry) => entry.index))).toEqual([[0]]);
    expect(classified.deferred.map((entry) => entry.index)).toEqual([1]);
  });

  it('does not treat PlanMode enter or a missing action as a barrier', () => {
    for (const args of [{ action: 'enter' }, {}]) {
      const classified = classifyToolCalls([
        call('plan', 'PlanMode', args),
        call('write', 'Write', { file_path: 'a.txt', content: 'x' }),
      ], undefined, options);
      expect(classified.deferred).toEqual([]);
      expect(classified.segments.flat().map((entry) => entry.toolCall.name)).toEqual(['PlanMode', 'Write']);
    }
  });

  it('defers a second barrier instead of opening another segment', () => {
    const classified = classifyToolCalls([
      call('1', 'AskUserQuestion', { questions: [] }),
      call('2', 'Write', { file_path: 'a.txt', content: 'x' }),
      call('3', 'confirm_action'),
    ], undefined, options);
    expect(classified.segments).toHaveLength(1);
    expect(classified.deferred.map((entry) => entry.toolCall.name)).toEqual(['Write', 'confirm_action']);
  });

  it.each([
    ['task_update(status=completed)', 'task_list', call('1', 'task_update', { task_id: 'T1', status: 'completed' }), call('2', 'task_list', {})],
    ['plan_update', 'plan_read', call('1', 'plan_update', { stepId: 's1', stepContent: 'x', status: 'done' }), call('2', 'plan_read', {})],
    ['Write(task_plan.md)', 'plan_read', call('1', 'Write', { file_path: 'task_plan.md', content: 'x' }), call('2', 'plan_read', {})],
  ])('splits an unscoped read after %s from %s into a later segment', (_label, _readName, writeCall, readCall) => {
    getProtocolRegistry();
    const classified = classifyToolCalls([writeCall, readCall], undefined, options);
    expect(classified.segments.map((segment) => segment.map((entry) => entry.toolCall.name))).toEqual([
      [writeCall.name],
      [readCall.name],
    ]);
  });

  it('still shares a segment between an unscoped read and a path read', () => {
    getProtocolRegistry();
    expect(classifyToolCalls([
      call('1', 'task_list', {}),
      call('2', 'Read', { file_path: 'a.txt' }),
    ], undefined, options).segments).toHaveLength(1);
  });

  it('splits a write from a read of the same file spelled with ~ (tools expand it, so must the scheduler)', () => {
    getProtocolRegistry();
    const homeFile = `${homedir()}/k2-notes.md`;
    const write = call('w', 'Write', { file_path: homeFile, content: 'x' });
    const read = call('r', 'Read', { file_path: '~/k2-notes.md' });
    expect(classifyToolCalls([write, read], undefined, options)
      .segments.map((segment) => segment.map((entry) => entry.toolCall.name))).toEqual([['Write'], ['Read']]);
    expect(classifyToolCalls([read, write], undefined, options).segments).toHaveLength(2);
  });

  it.each([
    'a.md lines 1-20',
    'a.md line 7',
    'a.md offset=10',
    'a.md offset 10 limit 5',
  ])('splits Write(a.md) from Read(%s): Read strips embedded params, so must the scheduler', (file_path) => {
    getProtocolRegistry();
    const classified = classifyToolCalls([
      call('w', 'Write', { file_path: 'a.md', content: 'x' }),
      call('r', 'Read', { file_path }),
    ], undefined, options);
    expect(classified.segments.map((segment) => segment.map((entry) => entry.toolCall.name))).toEqual([['Write'], ['Read']]);
  });

  it('still parallelizes embedded-param reads of different files', () => {
    getProtocolRegistry();
    expect(classifyToolCalls([
      call('1', 'Read', { file_path: 'a.md lines 1-5' }),
      call('2', 'Read', { file_path: 'b.md lines 1-5' }),
    ], undefined, options).segments).toHaveLength(1);
  });
});
