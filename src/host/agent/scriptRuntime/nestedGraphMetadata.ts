import { createHash } from 'node:crypto';
import {
  NESTED_GRAPH_PROTOCOL_VERSION,
  type NestedWorkflowIdentity,
  type NestedWorkflowMetadata,
} from './types';

const FORBIDDEN_KEYS = /(?:credential|authorization|api[-_]?key|token|secret|password|cookie|\benv\b)/i;

function isSafeId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return false;
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  });
}

export function deriveNestedGraphId(input: {
  workflowRunId: string;
  scriptHash: string;
  parentGraphId: string;
  parentNodeId: string;
}): string {
  return `nested:${digest([input.workflowRunId, input.scriptHash, input.parentGraphId, input.parentNodeId])}`;
}

export function createNestedWorkflowIdentity(input: Omit<NestedWorkflowIdentity, 'protocolVersion' | 'nestedGraphId'> & {
  nestedGraphId?: string;
}): NestedWorkflowIdentity {
  const identity: NestedWorkflowIdentity = {
    protocolVersion: NESTED_GRAPH_PROTOCOL_VERSION,
    workflowRunId: input.workflowRunId,
    parentGraphId: input.parentGraphId,
    parentNodeId: input.parentNodeId,
    nestedGraphId: input.nestedGraphId ?? deriveNestedGraphId(input),
    scriptHash: input.scriptHash,
  };
  assertNestedWorkflowIdentity(identity);
  return identity;
}

export function assertNestedWorkflowIdentity(value: NestedWorkflowIdentity): void {
  if (value.protocolVersion !== NESTED_GRAPH_PROTOCOL_VERSION) throw new Error('unsupported nested graph protocol');
  for (const [key, field] of Object.entries(value)) {
    if (key === 'protocolVersion' || key === 'scriptHash') continue;
    if (!isSafeId(field)) throw new Error(`invalid nested graph identity: ${key}`);
  }
  if (!/^[a-f0-9]{16,64}$/i.test(value.scriptHash)) throw new Error('invalid nested graph script hash');
  if (value.parentNodeId === value.nestedGraphId) throw new Error('parent and nested graph identities overlap');
}

export function assertNestedWorkflowMetadata(value: unknown): asserts value is NestedWorkflowMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('nested graph metadata must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`forbidden nested graph metadata key: ${key}`);
  }
  if (record.protocolVersion !== NESTED_GRAPH_PROTOCOL_VERSION) throw new Error('unsupported nested graph metadata protocol');
  for (const key of ['workflowRunId', 'parentGraphId', 'parentNodeId', 'nestedGraphId', 'groupId', 'nodeId']) {
    if (!isSafeId(record[key])) throw new Error(`invalid nested graph metadata: ${key}`);
  }
  if (!['single', 'parallel', 'pipeline'].includes(String(record.groupKind))) throw new Error('invalid nested graph group kind');
  for (const key of ['itemId', 'stageId']) {
    if (record[key] !== undefined && !isSafeId(record[key])) {
      throw new Error(`invalid nested graph metadata: ${key}`);
    }
  }
  if (!Number.isInteger(record.callIndex) || (record.callIndex as number) < 1) throw new Error('invalid nested graph call index');
  if (!['none', 'read_only', 'idempotent', 'unknown'].includes(String(record.sideEffect))) throw new Error('invalid nested graph side effect');
  if (!Array.isArray(record.dependencyNodeIds) || record.dependencyNodeIds.some((id) => !isSafeId(id))) {
    throw new Error('invalid nested graph dependencies');
  }
  if ((record.dependencyNodeIds as string[]).includes(record.nodeId as string)) throw new Error('nested graph node cannot depend on itself');
}

function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}
